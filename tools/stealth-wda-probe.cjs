/**
 * Stealth capture probe (run with Electron, not with node):
 *
 *   node_modules/.bin/electron tools/stealth-wda-probe.cjs
 *
 * The reported bug: a content-protected overlay shows up as a BLACK RECTANGLE
 * to a screen share after the window is hidden with 「—」 and brought back from
 * the tray, instead of being invisible. That is a property of Windows'
 * SetWindowDisplayAffinity and the window's show state, so it can only be
 * measured, not reasoned about.
 *
 * Method: a solid green backdrop window sits behind a transparent window whose
 * centre is painted opaque red. Sampling the point where they overlap
 * distinguishes the three outcomes unambiguously:
 *
 *   green -> the protected window is excluded from the capture (隐身 works)
 *   black -> the capture holds a black slab (the reported bug)
 *   red   -> the window's own pixels arrived (protection not in effect)
 *
 * The green backdrop doubles as the known-true control: a sample that is
 * neither green nor red nor black means the probe is not looking at the window
 * it thinks it is.
 *
 * Two capture paths are sampled because capturing apps differ: desktopCapturer
 * goes through the OS screen-capture API, CopyFromScreen goes through GDI
 * BitBlt of the composited screen.
 *
 * Each scenario runs the same sequence of show-state transitions, so the only
 * variables are when setContentProtection() was called and whether the window
 * is transparent at all.
 */
const { app, BrowserWindow, screen, desktopCapturer } = require('electron');
const { execFileSync } = require('child_process');

const B = { x: 320, y: 240, w: 420, h: 280 };
/** DIP offset of the sampled point inside the target window (its centre) */
const IN = { dx: Math.round(B.w / 2), dy: Math.round(B.h / 2) };

const page = (bg, useDiv) =>
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(
    `<style>html,body{margin:0;height:100%;background:transparent}` +
      (useDiv ? `#c{position:absolute;inset:40px;background:${bg}}` : `body{background:${bg}}`) +
      `</style><div id="c"></div>`,
  );

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** physical-pixel centre of the target window on the primary display */
function centrePhysical(display) {
  const sf = display.scaleFactor;
  return {
    x: Math.round((display.bounds.x + B.x + IN.dx) * sf),
    y: Math.round((display.bounds.y + B.y + IN.dy) * sf),
  };
}

/** --point x,y in PHYSICAL screen pixels, for sampling another process's window */
function pointOverride(argv) {
  const i = argv.indexOf('--point');
  if (i < 0) return null;
  const [x, y] = argv[i + 1].split(',').map(Number);
  return { x: Math.round(x), y: Math.round(y) };
}

/** one pixel through GDI BitBlt of the screen DC (coordinates must be physical) */
function gdiPixel(point) {
  const { x, y } = point;
  const ps = [
    'Add-Type -AssemblyName System.Drawing',
    "Add-Type -Namespace Win32 -Name Dpi -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware();'",
    '[Win32.Dpi]::SetProcessDPIAware() | Out-Null',
    `$bmp = New-Object System.Drawing.Bitmap 8, 8`,
    `$g = [System.Drawing.Graphics]::FromImage($bmp)`,
    `$g.CopyFromScreen(${x - 4}, ${y - 4}, 0, 0, $bmp.Size)`,
    `$p = $bmp.GetPixel(4, 4)`,
    `Write-Output ("PX {0} {1} {2}" -f $p.R, $p.G, $p.B)`,
    '$g.Dispose(); $bmp.Dispose()',
  ].join('\n');
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
  });
  const m = out.match(/PX (\d+) (\d+) (\d+)/);
  return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
}

/** the same point through Electron's own screen capture source */
async function wgcPixel(display, point) {
  const sf = display.scaleFactor;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * sf),
      height: Math.round(display.size.height * sf),
    },
  });
  const src = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
  if (!src) return null;
  const img = src.thumbnail;
  const size = img.getSize();
  if (size.width < 16) return null;
  const bmp = img.toBitmap(); // BGRA, row-major
  const x = Math.round((point.x * size.width) / (display.size.width * sf));
  const y = Math.round((point.y * size.height) / (display.size.height * sf));
  const i = (y * size.width + x) * 4;
  return { r: bmp[i + 2], g: bmp[i + 1], b: bmp[i] };
}

function classify(p) {
  if (!p) return 'NO-SAMPLE';
  const { r, g, b } = p;
  if (r < 24 && g < 24 && b < 24) return 'BLACK=slab(bug)';
  if (g > 150 && r < 90 && b < 90) return 'green=excluded(ok)';
  if (r > 150 && g < 90 && b < 90) return 'RED=visible(lost)';
  return `other(${r},${g},${b})`;
}

function makeTarget({ protectedAt, opaque }) {
  const win = new BrowserWindow({
    x: B.x,
    y: B.y,
    width: B.w,
    height: B.h,
    frame: false,
    transparent: !opaque,
    backgroundColor: opaque ? '#ff0000' : '#00000000',
    hasShadow: false,
    skipTaskbar: true,
    resizable: false,
    show: false,
    webPreferences: { contextIsolation: true },
  });
  void win.loadURL(page(opaque ? '#ff0000' : 'rgba(255,0,0,1)', !opaque));
  win.setAlwaysOnTop(true, 'screen-saver');
  if (protectedAt === 'create') win.setContentProtection(true);
  return win;
}

app
  .whenReady()
  .then(async () => {
    const display = screen.getPrimaryDisplay();
    console.log(
      `[probe] display ${display.id} bounds=${JSON.stringify(display.bounds)} size=${JSON.stringify(display.size)} scale=${display.scaleFactor}`,
    );

    // --sample --point x,y : read one physical pixel through both capture paths
    // and exit. Used by stealth-app-probe.mjs to look at the real app's window.
    const pt = pointOverride(process.argv);
    if (process.argv.includes('--sample')) {
      if (!pt) throw new Error('--sample needs --point x,y in physical pixels');
      const wgc = await wgcPixel(display, pt);
      const gdi = gdiPixel(pt);
      console.log(
        `SAMPLE wgc ${classify(wgc).padEnd(20)} gdi ${classify(gdi)} rgb=${wgc ? `${wgc.r},${wgc.g},${wgc.b}` : '-'} | ${gdi ? `${gdi.r},${gdi.g},${gdi.b}` : '-'}`,
      );
      app.exit(0);
      return;
    }

    const backdrop = new BrowserWindow({
      x: B.x - 140,
      y: B.y - 140,
      width: B.w + 280,
      height: B.h + 280,
      frame: false,
      transparent: false,
      backgroundColor: '#00ff00',
      skipTaskbar: true,
      hasShadow: false,
      resizable: false,
      webPreferences: { contextIsolation: true },
    });
    void backdrop.loadURL(page('#00ff00', false));
    await wait(1800);

    const sample = async (label, target) => {
      void target;
      const p = centrePhysical(display);
      const wgc = await wgcPixel(display, p);
      const gdi = gdiPixel(p);
      console.log(`${label.padEnd(44)} wgc ${classify(wgc).padEnd(20)} gdi ${classify(gdi)}`);
    };

    for (const scen of [
      { name: 'protect@create transparent', protectedAt: 'create', opaque: false },
      { name: 'protect@show   transparent', protectedAt: 'show', opaque: false },
      { name: 'protect@create opaque    ', protectedAt: 'create', opaque: true },
    ]) {
      const win = makeTarget(scen);
      await new Promise((r) => win.once('ready-to-show', r));
      win.show();
      await wait(1000);
      await sample(`${scen.name} [first show]`, win);

      win.hide();
      await wait(600);
      win.show();
      await wait(1000);
      await sample(`${scen.name} [after hide->show]`, win);

      win.minimize();
      await wait(500);
      win.restore();
      await wait(1000);
      await sample(`${scen.name} [after min->restore]`, win);

      if (scen.protectedAt === 'show') {
        win.setContentProtection(true);
        await wait(900);
        await sample(`${scen.name} [protect applied late]`, win);
      }
      win.close();
      await wait(400);
    }
    backdrop.close();
    console.log('\n[probe] green=excluded(stealth ok)  BLACK=slab(reported bug)  RED=visible(protection off)');
    app.quit();
  })
  .catch((e) => {
    console.error('[probe] threw', e);
    app.exit(1);
  });
