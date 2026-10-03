// Decrypt one stored API key and hand it to a file descriptor, never to argv.
//
// Runs as an Electron main process because safeStorage only exists there, and
// it must mirror electron/main.ts's app.setName before ready or it would look up
// a different keyring entry and fail to decrypt.
//
// usage: electron unlock-key.cjs <settings.json> <output-file> [slot]
// slot: llm (default) | vision | asr-cloud | asr-realtime | webSearch
const { app, safeStorage } = require('electron');
const { readFileSync, writeFileSync, chmodSync } = require('fs');

app.setName('MeetingAssistant');

app.whenReady().then(() => {
  const [settingsPath, outPath, slot = 'llm'] = process.argv.slice(2);
  const fail = (msg) => {
    process.stderr.write(`UNLOCK_FAIL: ${msg}\n`);
    app.exit(1);
  };
  if (!settingsPath || !outPath) return fail('need <settings.json> <output-file>');
  if (!safeStorage.isEncryptionAvailable()) {
    return fail('safeStorage unavailable — is the GNOME Keyring / KWallet running and unlocked?');
  }
  let json;
  try {
    json = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch (e) {
    return fail(`cannot read settings: ${e.message}`);
  }
  const table = {
    llm: json.llm,
    vision: json.vision,
    'asr-cloud': json.asr && json.asr.cloud,
    'asr-realtime': json.asr && json.asr.realtime,
    webSearch: json.webSearch,
  };
  const entry = table[slot];
  if (!entry) return fail(`unknown slot ${slot}`);
  if (!entry.apiKeyEnc) return fail(`no key stored in slot '${slot}'`);
  let plain;
  try {
    plain = safeStorage.decryptString(Buffer.from(entry.apiKeyEnc, 'base64'));
  } catch (e) {
    return fail(`decrypt failed: ${e.message}`);
  }
  // the caller created this file with mktemp; tighten it regardless
  try {
    chmodSync(outPath, 0o600);
  } catch {
    /* best effort */
  }
  writeFileSync(outPath, plain, { mode: 0o600 });
  app.exit(0);
});
