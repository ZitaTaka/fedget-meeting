// 起動環境チェック（ES Modules 読み込み前に実行される classic script）
// file:// 直接起動では ES Modules が CORS 制限で読み込めないため、ローカル HTTP サーバーでの起動を案内する。
(function () {
  function show(message) {
    var run = function () {
      var banner = document.getElementById('env-banner');
      if (!banner) return;
      banner.textContent = message;
      banner.hidden = false;
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
    else run();
  }
  if (location.protocol === 'file:') {
    show('file:// で開かれています。ブラウザの制約により ES Modules・マイク等が動作しません。ターミナルでこのフォルダに移動し「python -m http.server 8000」を実行して http://localhost:8000/ を開いてください（README 参照）。');
    return;
  }
  if (!window.isSecureContext) {
    show('安全なコンテキスト（HTTPS または localhost）ではないため、マイク・画面共有・音声認識が利用できません。http://localhost:8000/ または HTTPS で開いてください。');
  }
  // モジュールが読み込めなかった場合の検知
  window.setTimeout(function () {
    if (!window.__LMA_READY__ && location.protocol !== 'file:') {
      show('アプリの読み込みに失敗しました。Chrome / Edge の最新版を使用し、ローカル HTTP サーバー経由で開いてください。');
    }
  }, 4000);
})();
