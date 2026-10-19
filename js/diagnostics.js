// 環境診断: マイク・音声認識・画面共有が動かない原因の切り分け用。
// 結果は { group, label, status: 'ok'|'warn'|'error'|'info', value, hint } の配列で返す。

import { resolveLanguage } from './speech-service.js';

const SR = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : undefined;

export function detectPlatform() {
  const ua = navigator.userAgent || '';
  const p = navigator.userAgentData?.platform || '';
  if (/Windows/i.test(p) || /Windows/i.test(ua)) return 'windows';
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/mac/i.test(p) || /Macintosh/i.test(ua)) return 'mac';
  return 'other';
}

export function detectBrowser() {
  const brands = navigator.userAgentData?.brands?.map((b) => `${b.brand} ${b.version}`).filter((b) => !/Not.?A.?Brand|Chromium/i.test(b)) || [];
  if (brands.length) return brands.join(', ');
  const ua = navigator.userAgent || '';
  const m = ua.match(/(Edg|Chrome|CriOS|Firefox|FxiOS|Version)\/([\d.]+)/);
  if (!m) return ua.slice(0, 80);
  const name = { Edg: 'Edge', CriOS: 'Chrome (iOS)', FxiOS: 'Firefox (iOS)', Version: 'Safari' }[m[1]] || m[1];
  return `${name} ${m[2].split('.')[0]}`;
}

/** アプリ内ブラウザ（LINE / Slack / Facebook 等の WebView）の簡易判定 */
function detectInAppBrowser() {
  const ua = navigator.userAgent || '';
  const m = ua.match(/(Line|FBAN|FBAV|Instagram|Slack|MicroMessenger|Teams|Electron|; wv\))/i);
  return m ? m[1].replace('; wv)', 'Android WebView') : '';
}

/** マイク取得エラー名 → 原因と対処 */
export function micErrorHint(name, platform = detectPlatform()) {
  const win = platform === 'windows';
  switch (name) {
    case 'NotFoundError':
    case 'OverconstrainedError':
      return win
        ? 'ブラウザからマイクが 1 つも見えていません。Windows の「設定 → システム → サウンド → 入力」にマイクがあるか、「設定 → プライバシーとセキュリティ → マイク」で「マイクへのアクセス」「デスクトップアプリにマイクへのアクセスを許可する」がオンかを確認してください。リモートデスクトップ / VDI ではマイクの転送設定が必要です。'
        : 'マイクが検出されません。マイクの接続と OS のマイク権限を確認してください。';
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return win
        ? 'ブラウザまたは OS で拒否されています。アドレスバー左のサイト情報 → マイクを「許可」に。Windows の「プライバシーとセキュリティ → マイク」もオンか確認してください。管理 PC では管理者ポリシー（AudioCaptureAllowed）で禁止されている場合があります。'
        : 'マイクの利用が拒否されています。ブラウザのサイト設定と OS のマイク権限を確認してください。';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return '他のアプリ（Teams / Zoom 等）がマイクを占有しているか、ドライバの問題です。他アプリを終了するか、別のマイクを試してください。';
    case 'NotSupportedError':
      return 'この環境ではブラウザがマイク入力を提供できません。マイクが 1 つもない PC、リモートデスクトップ / VDI（音声転送なし）、管理ポリシーで音声取り込みが禁止された PC、アプリ内ブラウザなどで発生します。chrome://policy（Edge は edge://policy）の AudioCaptureAllowed も確認してください。';
    case 'SecurityError':
      return 'セキュアでない接続、または埋め込み（iframe）の制限によりブロックされています。https:// で直接開いてください。';
    case 'TypeError':
      return 'ブラウザがマイク取得 API に対応していないか、HTTPS / localhost で開かれていません。';
    default:
      return '';
  }
}

/** 静的チェック（ユーザー操作不要・プロンプトを出さない） */
export async function runStaticDiagnostics({ language = 'auto' } = {}) {
  const items = [];
  const add = (group, label, status, value, hint = '') => items.push({ group, label, status, value: String(value ?? ''), hint });
  const platform = detectPlatform();

  // 環境
  add('環境', 'ブラウザ', 'info', detectBrowser());
  add('環境', 'OS', 'info', { windows: 'Windows', mac: 'macOS', android: 'Android', ios: 'iOS / iPadOS', other: navigator.userAgentData?.platform || '不明' }[platform]);
  const inApp = detectInAppBrowser();
  if (inApp) add('環境', 'アプリ内ブラウザ', 'warn', inApp, 'アプリ内ブラウザではマイクや音声認識が使えないことが多いです。Chrome / Edge / Safari で直接開いてください。');
  add('環境', 'URL', location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname) ? 'ok' : 'error', `${location.protocol}//${location.host}${location.pathname}`,
    location.protocol === 'file:' ? 'file:// では動作しません。HTTP サーバー経由で開いてください。' : '');
  add('環境', 'セキュアコンテキスト', window.isSecureContext ? 'ok' : 'error', window.isSecureContext ? 'はい' : 'いいえ', window.isSecureContext ? '' : 'HTTPS または localhost で開く必要があります。');
  let framed = false;
  try {
    framed = window.self !== window.top;
  } catch {
    framed = true;
  }
  if (framed) add('環境', '埋め込み表示', 'warn', 'iframe 内', 'iframe 内ではマイク・画面共有が制限されることがあります。ページを直接開いてください。');
  add('環境', 'ネットワーク', navigator.onLine ? 'ok' : 'error', navigator.onLine ? 'オンライン' : 'オフライン', navigator.onLine ? '' : 'Chrome / Edge の音声認識と LLM はネットワーク接続が必要です。');

  // API 対応
  const md = navigator.mediaDevices;
  add('API', 'マイク取得 (getUserMedia)', md?.getUserMedia ? 'ok' : 'error', md?.getUserMedia ? '対応' : '非対応', md?.getUserMedia ? '' : micErrorHint('TypeError', platform));
  add('API', '画面・タブ共有 (getDisplayMedia)', md?.getDisplayMedia ? 'ok' : 'warn', md?.getDisplayMedia ? '対応' : '非対応', md?.getDisplayMedia ? '' : 'System Audio は使えません（Microphone モードを使用）。スマートフォンは非対応です。');
  add('API', '音声認識 (Web Speech API)', SR ? 'ok' : 'error', SR ? (window.SpeechRecognition ? 'SpeechRecognition' : 'webkitSpeechRecognition') : '非対応',
    SR ? '' : 'Chrome または Edge を使用してください（Firefox は非対応）。');
  // ブラウザ標準 API が拡張機能等で置き換えられていないか（企業のセキュリティ拡張機能が上書きする場合がある）
  const isNative = (fn) => {
    try {
      return typeof fn === 'function' && /\[native code\]/.test(Function.prototype.toString.call(fn));
    } catch {
      return false;
    }
  };
  const overridden = [
    ['getUserMedia', md?.getUserMedia],
    ['getDisplayMedia', md?.getDisplayMedia],
    ['enumerateDevices', md?.enumerateDevices],
    ['SpeechRecognition', SR],
  ].filter(([, fn]) => fn && !isNative(fn)).map(([n]) => n);
  add('API', 'ブラウザ標準 API の改変', overridden.length ? 'warn' : 'ok', overridden.length ? `置き換えあり: ${overridden.join(', ')}` : 'なし（標準のまま）',
    overridden.length ? '拡張機能（企業のセキュリティ / DLP 拡張機能など）が API を置き換えています。許可されたサイト以外でマイク・画面共有をブロックしている可能性があります。' : '');
  add('API', 'Web Audio (AudioContext)', window.AudioContext || window.webkitAudioContext ? 'ok' : 'warn', window.AudioContext || window.webkitAudioContext ? '対応' : '非対応');
  let lsOk = false;
  try {
    localStorage.setItem('lma.diag', '1');
    localStorage.removeItem('lma.diag');
    lsOk = true;
  } catch {
    /* ignore */
  }
  add('API', 'LocalStorage', lsOk ? 'ok' : 'warn', lsOk ? '利用可' : '利用不可', lsOk ? '' : '設定が保存されません（プライベートモードや保存制限の可能性）。');

  // 権限
  const policy = document.permissionsPolicy || document.featurePolicy;
  if (policy?.allowsFeature) {
    const allowed = policy.allowsFeature('microphone');
    add('権限', 'Permissions Policy (microphone)', allowed ? 'ok' : 'error', allowed ? '許可' : 'ブロック', allowed ? '' : 'ページの埋め込み元がマイクを許可していません。直接開いてください。');
  }
  if (navigator.permissions?.query) {
    try {
      const st = await navigator.permissions.query({ name: 'microphone' });
      const map = { granted: ['ok', '許可済み'], prompt: ['info', '未確認（開始時に確認ダイアログ）'], denied: ['error', '拒否'] };
      const [s, v] = map[st.state] || ['info', st.state];
      add('権限', 'マイク権限（このサイト）', s, v, st.state === 'denied' ? micErrorHint('NotAllowedError', platform) : '');
    } catch {
      add('権限', 'マイク権限（このサイト）', 'info', '取得不可（ブラウザ非対応）');
    }
  }

  // デバイス
  if (md?.enumerateDevices) {
    try {
      const devices = await md.enumerateDevices();
      const inputs = devices.filter((d) => d.kind === 'audioinput');
      const labeled = inputs.filter((d) => d.label);
      if (!inputs.length) {
        add('デバイス', '音声入力デバイス', 'error', '0 件', micErrorHint('NotFoundError', platform));
      } else {
        add('デバイス', '音声入力デバイス', 'ok', `${inputs.length} 件${labeled.length ? '' : '（名前は権限許可後に表示）'}`);
        labeled
          .filter((d) => d.deviceId !== 'communications')
          .slice(0, 8)
          .forEach((d) => add('デバイス', d.deviceId === 'default' ? '  既定' : '  ・', 'info', d.label));
      }
    } catch (err) {
      add('デバイス', '音声入力デバイス', 'error', `列挙失敗: ${err.name}`, err.message);
    }
  }
  add('音声認識', '認識言語', 'info', resolveLanguage(language));
  return items;
}

/** マイク取得テスト（最小構成の制約で取得し、3 秒間の最大入力レベルを測る） */
export async function testMicrophone({ durationMs = 3000, onLevel } = {}) {
  const platform = detectPlatform();
  if (!navigator.mediaDevices?.getUserMedia) {
    return { status: 'error', value: 'getUserMedia 非対応', hint: micErrorHint('TypeError', platform) };
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    return { status: 'error', value: `${err.name}: ${err.message}`, hint: micErrorHint(err.name, platform) };
  }
  const track = stream.getAudioTracks()[0];
  let peak = 0;
  let ctx = null;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) {
      ctx = new Ctx();
      await ctx.resume().catch(() => {});
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Float32Array(an.fftSize);
      const end = Date.now() + durationMs;
      while (Date.now() < end) {
        an.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const lv = Math.min(1, Math.sqrt(sum / buf.length) * 4);
        peak = Math.max(peak, lv);
        onLevel?.(lv);
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  } finally {
    stream.getTracks().forEach((t) => t.stop());
    if (ctx) ctx.close().catch(() => {});
    onLevel?.(0);
  }
  const label = track?.label || '（名前なし）';
  if (peak < 0.02) {
    return {
      status: 'warn',
      value: `取得成功: ${label} / 入力ほぼ無音（最大 ${Math.round(peak * 100)}%）`,
      hint: 'マイクは取得できましたが音が入っていません。テスト中に話したか、ミュート・入力音量・既定のデバイスを確認してください。',
    };
  }
  return { status: 'ok', value: `取得成功: ${label} / 最大入力 ${Math.round(peak * 100)}%` };
}

const SPEECH_HINTS = {
  'not-allowed': 'マイクまたは音声認識が拒否されています。サイトのマイク権限を確認してください。',
  'service-not-allowed': 'ブラウザが音声認識サービスを許可していません（Edge / Chrome の設定・管理ポリシー、または非対応ブラウザ）。',
  'audio-capture': 'マイクを取得できません。先に「マイクを試す」で原因を確認してください。',
  network: '音声認識サービスに接続できません。Chrome / Edge の音声認識はクラウドを使うため、プロキシやファイアウォールで遮断されている可能性があります。',
  'language-not-supported': '指定の認識言語に対応していません。',
  'no-speech': '音声が検出されませんでした。テスト中に話してください。',
};

/** 音声認識テスト（最長 durationMs、最初の確定結果またはエラーで終了） */
export function testSpeechRecognition({ lang, durationMs = 8000, onEvent } = {}) {
  return new Promise((resolve) => {
    if (!SR) {
      resolve({ status: 'error', value: 'Web Speech API 非対応', hint: 'Chrome または Edge を使用してください。' });
      return;
    }
    const events = [];
    const log = (e) => {
      events.push(e);
      onEvent?.(e);
    };
    let rec;
    let finished = false;
    let error = '';
    let finalText = '';
    let interimText = '';
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        rec.abort();
      } catch {
        /* ignore */
      }
      if (finalText || interimText) resolve({ status: 'ok', value: `認識成功: 「${finalText || interimText}」`, events });
      else if (error) resolve({ status: error === 'no-speech' ? 'warn' : 'error', value: `エラー: ${error}`, hint: SPEECH_HINTS[error] || '', events });
      else if (events.includes('audiostart')) resolve({ status: 'warn', value: '音声入力は開始したが認識結果なし', hint: 'テスト中に話してください。話しても結果が出ない場合はネットワーク（音声認識サービス）を確認してください。', events });
      else resolve({ status: 'error', value: '音声入力が開始されませんでした', hint: '先に「マイクを試す」で確認してください。', events });
    };
    const timer = setTimeout(finish, durationMs);
    try {
      rec = new SR();
      rec.lang = lang;
      rec.continuous = false;
      rec.interimResults = true;
      rec.onstart = () => log('start');
      rec.onaudiostart = () => log('audiostart');
      rec.onspeechstart = () => log('speechstart');
      rec.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0]?.transcript || '';
          if (e.results[i].isFinal) finalText += t;
          else interimText = t;
        }
        log('result');
        if (finalText) finish();
      };
      rec.onerror = (e) => {
        error = e.error || 'unknown';
        log(`error:${error}`);
      };
      rec.onend = () => {
        log('end');
        finish();
      };
      rec.start();
    } catch (err) {
      error = `${err.name}: ${err.message}`;
      finish();
    }
  });
}

export function formatDiagnostics(items) {
  const lines = [`LLM Meeting Assistant 診断結果 ${new Date().toLocaleString('ja-JP')}`, navigator.userAgent, ''];
  const mark = { ok: '[OK]', warn: '[注意]', error: '[NG]', info: '[-]' };
  let group = '';
  for (const it of items) {
    if (it.group !== group) {
      group = it.group;
      lines.push(`■ ${group}`);
    }
    lines.push(`${mark[it.status] || '[-]'} ${it.label.trim()}: ${it.value}${it.hint ? `\n    → ${it.hint}` : ''}`);
  }
  return lines.join('\n');
}
