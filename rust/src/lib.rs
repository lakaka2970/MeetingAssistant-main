/**
 * MeetingAssistant native audio capture (upgrade P1.5): Windows WASAPI shared
 * -mode loopback (the system mix, no virtual device) plus cross-platform mic
 * capture via cpal. Everything is downmixed to mono and resampled to 16 kHz
 * float32, emitted as ~100 ms frames (1600 samples) through a
 * ThreadsafeFunction — byte-compatible with the Web Audio pipeline the
 * renderer already speaks (electron IPC.capturePcm contract), so the ASR host
 * cannot tell the two paths apart.
 *
 * Build: `npm run native:build` from the repo root (needs a Rust toolchain;
 * see rust/README.md). The loader (electron/audio/nativeCapture.ts) degrades
 * gracefully to the Web Audio path when the .node artifact is absent.
 */
use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunction;
use napi_derive::napi;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// streaming linear-interpolation resampler (device rate -> 16 kHz mono).
/// Quality is deliberately "good enough for ASR": linear interpolation keeps
/// the crate dependency-free and the CPU cost near zero.
struct Resampler {
    /// input sample rate in Hz
    in_rate: f64,
    /// fractional position between input samples for the next output sample
    pos: f64,
    /// last input sample of the previous push (stream continuity)
    prev: f32,
}

const OUT_RATE: f64 = 16000.0;

impl Resampler {
    fn new(in_rate: f64) -> Self {
        Self { in_rate, pos: 0.0, prev: 0.0 }
    }

    fn step(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if self.in_rate == OUT_RATE {
            out.extend_from_slice(input);
            return;
        }
        // input samples per output sample (48000 -> 3.0; 8000 -> 0.5)
        let ratio = self.in_rate / OUT_RATE;
        if input.is_empty() {
            return;
        }
        let mut p = self.pos;
        // virtual input stream: [prev, input...]; each span (a, b) covers one
        // input sample of time, outputs land every `ratio` input samples
        let mut idx = 0usize;
        while idx < input.len() {
            let a = if idx == 0 { self.prev } else { input[idx - 1] };
            let b = input[idx];
            while p < 1.0 {
                out.push(a + (b - a) * (p as f32));
                p += ratio;
            }
            p -= 1.0;
            idx += 1;
        }
        self.pos = p;
        self.prev = *input.last().unwrap();
    }
}

#[inline]
fn downmix(frame: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return frame.to_vec();
    }
    frame.chunks_exact(channels).map(|c| c.iter().sum::<f32>() / channels as f32).collect()
}

/// shared capture state: the stop flag + the JS callback
struct CaptureHandle {
    running: Arc<AtomicBool>,
}

#[napi]
pub struct AudioCapture {
    running: Arc<AtomicBool>,
}

#[napi]
impl AudioCapture {
    #[napi(constructor)]
    pub fn new() -> Result<Self> {
        Ok(Self { running: Arc::new(AtomicBool::new(false)) })
    }

    #[napi]
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Relaxed)
    }

    /// Windows system loopback (WASAPI shared mode on the default render
    /// device). Frames: 1600 f32 samples @16 kHz mono, ~100 ms.
    #[napi(ts_args_type = "callback: (err: null | Error, data: Buffer) => void")]
    pub fn start_loopback(&self, callback: ThreadsafeFunction<Buffer>) -> Result<()> {
        #[cfg(not(windows))]
        {
            let _ = &callback;
            return Err(Error::new(Status::GenericFailure, "loopback capture is Windows-only; use the Web Audio path"));
        }
        #[cfg(windows)]
        {
            if self.running.swap(true, Ordering::SeqCst) {
                return Err(Error::new(Status::GenericFailure, "capture already running"));
            }
            let running = self.running.clone();
            std::thread::spawn(move || {
                if let Err(e) = loopback_loop(running, callback) {
                    // the thread cannot napi-throw; surface via console and stop
                    eprintln!("[native-audio] loopback capture failed: {e}");
                }
            });
            Ok(())
        }
    }

    /// Microphone capture (cpal). `deviceId`: cpal device name, None = default.
    #[napi(ts_args_type = "deviceId: string | null, callback: (err: null | Error, data: Buffer) => void")]
    pub fn start_mic(&self, device_id: Option<String>, callback: ThreadsafeFunction<Buffer>) -> Result<()> {
        if self.running.swap(true, Ordering::SeqCst) {
            return Err(Error::new(Status::GenericFailure, "capture already running"));
        }
        let running = self.running.clone();
        std::thread::spawn(move || {
            if let Err(e) = mic_loop(running, device_id, callback) {
                eprintln!("[native-audio] mic capture failed: {e}");
            }
        });
        Ok(())
    }

    #[napi]
    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
    }
}

/// forward a 1600-sample f32 frame to JS (little-endian bytes; the TS side
/// reinterprets via Float32Array — same wire format as IPC.capturePcm)
fn emit(callback: &ThreadsafeFunction<Buffer>, frame: &[f32]) {
    let mut bytes = Vec::with_capacity(frame.len() * 4);
    for s in frame {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    let buf = Buffer::from(bytes);
    callback.call(Ok(buf), ThreadsafeFunctionCallMode::Nonblocking);
}

/// accumulate resampled samples into exactly-1600-sample frames
struct FrameAssembler {
    buf: Vec<f32>,
}

impl FrameAssembler {
    const FRAME: usize = 1600; // 100 ms @16 kHz

    fn new() -> Self {
        Self { buf: Vec::with_capacity(4096) }
    }

    fn push(&mut self, resampler: &mut Resampler, samples: &[f32], callback: &ThreadsafeFunction<Buffer>) {
        let mut out = Vec::with_capacity(samples.len() / 3 + 64);
        resampler.step(samples, &mut out);
        self.buf.extend_from_slice(&out);
        while self.buf.len() >= Self::FRAME {
            let frame: Vec<f32> = self.buf.drain(..Self::FRAME).collect();
            emit(callback, &frame);
        }
    }
}

#[cfg(windows)]
fn loopback_loop(running: Arc<AtomicBool>, callback: ThreadsafeFunction<Buffer>) -> Result<()> {
    use wasapi::*;

    initialize_msm()
        .map_err(|e| Error::new(Status::GenericFailure, format!("COM init: {e}")))?;
    let device = get_default_device(&Direction::Render)
        .map_err(|e| Error::new(Status::GenericFailure, format!("no render device: {e}")))?;
    let mut audio_client = device
        .get_iaudioclient()
        .map_err(|e| Error::new(Status::GenericFailure, format!("audioclient: {e}")))?;
    let format = audio_client
        .get_mixformat()
        .map_err(|e| Error::new(Status::GenericFailure, format!("mixformat: {e}")))?;
    // loopback = capture client on the RENDER device, shared mode
    let bufdur = audio_client
        .get_default_period()
        .map_err(|e| Error::new(Status::GenericFailure, format!("period: {e}")))?;
    audio_client
        .initialize_client(&format, bufdur, &Direction::Capture, &ShareMode::Shared, &Convert::None)
        .map_err(|e| Error::new(Status::GenericFailure, format!("init: {e}")))?;
    let h_event = audio_client
        .set_geteventhandle()
        .map_err(|e| Error::new(Status::GenericFailure, format!("event: {e}")))?;
    audio_client
        .start_stream()
        .map_err(|e| Error::new(Status::GenericFailure, format!("start: {e}")))?;

    let channels = format.channels() as usize;
    let in_rate = format.samprate() as f64;
    eprintln!("[native-audio] loopback open: {in_rate} Hz x {channels} ch");
    let mut resampler = Resampler::new(in_rate);
    let mut assembler = FrameAssembler::new();

    while running.load(Ordering::Relaxed) {
        h_event
            .wait_for_event(2000)
            .map_err(|e| Error::new(Status::GenericFailure, format!("event wait: {e}")))?;
        let available = audio_client
            .get_available_buffer_size()
            .map_err(|e| Error::new(Status::GenericFailure, format!("available: {e}")))?;
        if available == 0 {
            continue;
        }
        let (mut capture_buffer, frames) = audio_client
            .get_capturebuffer()
            .map_err(|e| Error::new(Status::GenericFailure, format!("buffer: {e}")))?;
        if frames > 0 {
            let data: &[f32] = capture_buffer
                .read_from_buffer::<f32>(frames, channels)
                .map_err(|e| Error::new(Status::GenericFailure, format!("read: {e}")))?;
            let mono = downmix(data, channels);
            assembler.push(&mut resampler, &mono, &callback);
        }
        capture_buffer
            .release_buffer()
            .map_err(|e| Error::new(Status::GenericFailure, format!("release: {e}")))?;
    }
    let _ = audio_client.stop_stream();
    Ok(())
}

fn mic_loop(
    running: Arc<AtomicBool>,
    device_id: Option<String>,
    callback: ThreadsafeFunction<Buffer>,
) -> Result<()> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    let host = cpal::default_host();
    let device = match &device_id {
        Some(id) => host
            .input_devices()
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?
            .find(|d| d.name().map(|n| n == *id).unwrap_or(false))
            .ok_or_else(|| Error::new(Status::GenericFailure, format!("mic device not found: {id}")))?,
        None => host
            .default_input_device()
            .ok_or_else(|| Error::new(Status::GenericFailure, "no default input device"))?,
    };
    let config = device
        .default_input_config()
        .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
    let sample_format = config.sample_format();
    let in_rate = config.sample_rate().0 as f64;
    let channels = config.channels() as usize;
    eprintln!("[native-audio] mic open: {in_rate} Hz x {channels} ch ({sample_format})");

    let mut resampler = Resampler::new(in_rate);
    let mut assembler = FrameAssembler::new();
    let err_fn = |e| eprintln!("[native-audio] cpal stream error: {e}");

    let stream = match sample_format {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config.into(),
            move |data: &[f32], _| {
                let mono = downmix(data, channels);
                assembler.push(&mut resampler, &mono, &callback);
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config.into(),
            move |data: &[i16], _| {
                let mono = downmix(&data.iter().map(|s| *s as f32 / 32768.0).collect::<Vec<f32>>(), channels);
                assembler.push(&mut resampler, &mono, &callback);
            },
            err_fn,
            None,
        ),
        _ => {
            return Err(Error::new(
                Status::GenericFailure,
                format!("unsupported mic sample format {sample_format}"),
            ))
        }
    }
    .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
    stream
        .play()
        .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;

    // park this thread until stop(); cpal drives the stream on its own thread
    while running.load(Ordering::Relaxed) {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    drop(stream);
    Ok(())
}
