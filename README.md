# LLM Meeting Assistant（MVP）

会議中に **Console / 音声認識（Transcript）/ リアルタイム議事録（Live Minutes）/ 会議アドバイザー（Meeting Advisor）/ メモ（Notes）** を 1 画面で扱う、PC 版 Chrome / Edge 向けのブラウザアプリです。

単なる文字起こしではなく、**「会議前コンテキスト（Context）× 現在までの会話」** を LLM が継続的に解釈し、

- 今何が議論されているか / 本来何を議論すべきか
- 何が決まったか / 何が未確認か / 次に何を確認すべきか
- 想定 QA に該当する質問への回答案
- 会議目的からの逸脱・時間配分の警告

をリアルタイムに提示します。

フロントエンドのみ（HTML / CSS / Vanilla JavaScript ES Modules）で構成され、ビルド・依存ライブラリ・バックエンドは不要です。

---

## 機能一覧

| 領域 | 機能 |
|---|---|
| Console | 会議名 / ステータス（Ready・Starting・Listening・Paused・Processing・Ended・Error）/ 経過時間と想定時間 / 開始・一時停止・再開 / 終了 / 保存（HTML Snapshot）/ 議事録作成 / Context Upload・Download・編集 / 新規 / 設定 |
| 状態表示 | 認識中・停止中、Mic 状態＋入力レベル、System Audio 状態＋入力レベル、認識言語、LLM 接続状態、直近の LLM 更新時刻と次回更新までの秒数、Context 登録状況、フォールバック理由、通知ログ |
| 音声入力 | Microphone（デバイス選択、echoCancellation / noiseSuppression / autoGainControl）、System Audio（画面・タブ共有）、Microphone + System Audio（Web Audio API でミックス） |
| 音声認識 | Web Speech API（continuous / interimResults）。Interim は薄く、Final は時刻付きで確定。ブラウザ側の意図しない終了時は Listening の場合のみ自動再開（バックオフ付き） |
| 認識言語 | Auto / 日本語 / English (US) / English (UK) |
| 誤認識辞書 | CSV（from,to）の Upload / Download / 画面編集 / 置換テスト。Final 確定後に from の長い順で機械置換 |
| Context | Markdown の Upload（.md / .txt）/ Download（未登録時は標準テンプレート）/ 画面編集・解析プレビュー |
| Live Minutes | 前回処理以降の新規 Transcript だけを LLM に渡し、議論単位のブロック（提示情報・論点・議論・決定・Action・未決・確認事項）を時系列に追記。累積サマリ（決定・Action・未決・Rolling Summary） |
| Meeting Advisor | 現在地 / 目的との整合 / Agenda 位置（順序変更対応）/ 逸脱検知 / 残り時間と時間アラート / 推奨する進め方 / 未確認事項 / 次に聞くべきこと / 想定 QA 回答案 / 残りの進行プラン。毎回全体を書き換え。「事実・推定・推奨」をバッジで区別 |
| Notes | 自由入力。議事録作成・LLM 入力に利用 |
| 議事録作成 | LLM で最終 Markdown 議事録を生成して `YYYYMMDD_HHmm_{会議名}_minutes.md` をダウンロード。LLM 未設定・エラー時も「LLMによる要約未実施」と明記したうえで会議情報・Context・Notes・Raw Transcript を出力 |
| 保存 | 自己完結型 HTML Snapshot（`YYYYMMDD_HHmm_{会議名}_snapshot.html`）。API Key 等の Secret は含めない |
| LLM | OpenAI 方式（OpenAI 互換 REST、Base URL 変更可）/ Gemini 方式。接続テスト付き |
| 自動保存 | 会議データをブラウザに自動保存し、誤リロード・クラッシュ後に復元を提案 |

---

## ディレクトリ構成

```
/
├─ index.html                 画面（Console / 4 パネル / 各ダイアログ）
├─ styles.css                 スタイル（12 カラム Grid、狭い画面では縦積み）
├─ app.js                     UI エントリポイント（結線・描画）
├─ README.md
├─ js/
│  ├─ app-state.js            状態（appState / meetingState / contextState / settingsState / audioState / llmState）と購読
│  ├─ meeting-controller.js   開始・一時停止・再開・終了の状態遷移（音声入力 → 認識 → Transcript）
│  ├─ meeting-assistant.js    LLM 定期処理（Live Minutes → Meeting State → Advisor）・最終議事録
│  ├─ speech-service.js       STT エンジン抽象化 + Web Speech API 実装・自動再開・言語解決
│  ├─ audio-service.js        getUserMedia / getDisplayMedia / Web Audio ミックス / 解放
│  ├─ llm-provider.js         LLMProvider 共通インターフェース・HTTP / エラー分類
│  ├─ openai-provider.js      OpenAI 方式
│  ├─ gemini-provider.js      Gemini 方式
│  ├─ llm-service.js          Provider ファクトリ・JSON 応答パーサ
│  ├─ prompts.js              プロンプト定義・LLM 出力の正規化
│  ├─ context-service.js      Context テンプレート・見出し解析・LLM 用ダイジェスト
│  ├─ dictionary-service.js   CSV パーサ・辞書置換
│  ├─ export-service.js       HTML Snapshot / Markdown 議事録
│  ├─ renderers.js            Transcript / Minutes / Advisor の DOM レンダラ（画面と Snapshot で共用）
│  ├─ markdown.js             安全な Markdown → DOM レンダラ
│  ├─ settings-service.js     設定の LocalStorage 永続化・破損時復旧
│  ├─ session-service.js      会議データ・Context の自動保存
│  ├─ notify.js               トースト・通知ログ
│  ├─ utils.js                共通ユーティリティ
│  └─ env-check.js            起動環境チェック（file:// / 非セキュアコンテキストの警告）
└─ sample/
   ├─ context-template.md     Context テンプレート（記入ガイド付き）
   ├─ context-example.md      記入例
   └─ recognition-dictionary.csv
```

---

## 起動方法

ES Modules とマイク・画面共有を使うため、**ローカル HTTP サーバー経由（http://localhost）** で開いてください。

```bash
cd このリポジトリのフォルダ
python -m http.server 8000
# または: python3 -m http.server 8000 / npx http-server -p 8000
```

ブラウザで **http://localhost:8000/** を開きます。

### Chrome / Edge 推奨

Web Speech API（`SpeechRecognition` / `webkitSpeechRecognition`）と画面・タブ音声共有は、デスクトップ版 Chrome / Edge の最新版を推奨します。Firefox / Safari では音声認識が利用できない、または挙動が異なります（Context・Notes・LLM 機能は利用可能）。

### localhost または HTTPS が必要な理由

- `getUserMedia`（マイク）・`getDisplayMedia`（画面共有）・音声認識は **セキュアコンテキスト（HTTPS または localhost）でのみ** 利用できます。
- `file://` で直接開くと、ブラウザの CORS 制限で ES Modules が読み込めません（画面上部に案内が表示されます）。
- 社内サーバー等で共有する場合は HTTPS で配信してください。

### Microphone 権限

初回の「開始」時（または 設定 → 音声 →「一覧を更新」）にブラウザがマイク許可を求めます。拒否した場合は、アドレスバー左のサイト情報アイコン → サイトの設定 → マイク を「許可」に変更して再読み込みしてください。マイクのデバイス名は許可後に表示されます。

---

## 使い方（基本の流れ）

1. **⚙ 設定 → LLM** で Provider・API Key・Model を入力し「接続テスト」→「保存」
2. **Context Upload**（または Context編集）で会議前情報を登録（`sample/context-example.md` 参照）
3. 必要なら **設定 → 誤認識辞書** で CSV を Upload
4. **▶ 開始** … 音声入力取得 → 音声認識開始 → 開始時刻記録 → タイマー開始 → LLM 定期処理開始
5. 会議中は Transcript・Live Minutes・Advisor が自動更新されます（既定 60 秒ごと、新しい確定発言がある場合のみ）。**今すぐ更新** で手動更新も可能
6. **❚❚ 一時停止** … 音声認識・音声処理・LLM 定期実行を停止（データは維持）。**▶ 再開** で続きから
7. **■ 終了** … マイク・画面共有を解放
8. **議事録作成**（Markdown）/ **保存**（HTML Snapshot）
9. 次の会議は **新規**（Context・設定は維持）

---

## System Audio 共有方法

通常の Web ページは OS のスピーカー出力デバイスを直接指定してキャプチャできません。本アプリは **「System Audio：画面・タブ共有から取得」** として `getDisplayMedia()` を使います。

1. 設定 → 音声 → 入力モードで **System Audio** または **Microphone + System Audio** を選択
2. 「開始」を押すとブラウザの共有ダイアログが開くので、共有対象を選択
   - **Chrome タブ**（Web 会議をブラウザで開いている場合に推奨）: 「タブの音声も共有」を ON
   - **画面全体**（Windows / ChromeOS）: 「システム音声を共有」を ON
   - **ウィンドウ**: 多くの環境で音声は共有されません
3. 取得できた音声トラック名・状態は状態バーの「System」に表示されます（ホバーで詳細）
4. 設定 → 音声 →「System Audio 取得テスト」で事前に確認できます

挙動:

- 共有対象に音声がない / 共有を拒否した場合は、エラー表示のうえ **Microphone へフォールバック** して会議を継続します
- 会議中に共有を停止した場合、System Audio モードはマイクへ切り替え、ミックスモードはマイクのみで継続します
- 一時停止中は再選択の手間を省くため共有を維持（トラックは無効化）し、終了時に解放します

### 音声トラック直接入力（SpeechRecognition.start(audioTrack)）について

Web Speech API は通常ブラウザ既定のマイクを使います。System Audio やミックス音声を認識させるには、比較的新しいブラウザで追加された `SpeechRecognition.start(audioTrack)` が必要です。

- 本アプリは feature detection（MediaStreamTrack 以外を渡したときの TypeError 有無）で対応を判定し、対応していれば Web Audio API でミックスした `MediaStreamAudioDestinationNode` のトラックを渡します
- 未対応ブラウザでは **「ブラウザが音声トラック直接入力に対応していないため、マイク認識へフォールバック」** と画面に表示し、ブラウザ既定マイクで認識します（System Audio は認識されません）
- マイクを個別選択した場合も、未対応ブラウザでは認識はブラウザ既定マイクとなり、選択はレベル表示のみに反映されます（OS / ブラウザの既定マイクを変更してください）
- 判定結果は 設定 → 音声 →「音声トラック直接入力への対応」で確認できます

---

## LLM 設定

設定 → LLM で Provider を選択します。Provider ごとに Base URL・API Key・Model を保持するため、切り替えても入力値は失われません。モデル名はコードに固定していないため、各 Provider のモデル一覧から利用するモデル ID を入力してください。

### OpenAI 方式

| 項目 | 内容 |
|---|---|
| Base URL | 既定 `https://api.openai.com/v1`。`{Base URL}/chat/completions` を呼び出します |
| API Key | `Authorization: Bearer` ヘッダーで送信。api.openai.com 以外（ローカルの OpenAI 互換サーバー等）では省略可 |
| Model | 利用するモデル ID |

OpenAI 互換サーバー（例: Ollama `http://localhost:11434/v1`、LM Studio、社内ゲートウェイ等）にも Base URL の変更で接続できます。ブラウザから直接呼び出すため、サーバー側で **CORS を許可** している必要があります。`response_format: json_object` 非対応のサーバーでは自動的に形式指定なしで再試行します。

### Gemini 方式

| 項目 | 内容 |
|---|---|
| Base URL | 既定 `https://generativelanguage.googleapis.com/v1beta`。`{Base URL}/models/{Model}:generateContent` を呼び出します |
| API Key | Google AI Studio で発行。`x-goog-api-key` ヘッダーで送信（URL には含めません） |
| Model | 利用するモデル ID（`models/` 接頭辞は省略可） |

### 接続テスト

「接続テスト」は短いプロンプトで実際に API を呼び出し、成功 / 失敗と理由（認証エラー・404・レート制限・ネットワーク / CORS 等）を表示します。

### LLM 呼び出しの仕組み（長時間会議対応）

```
New Transcript（lastProcessedTranscriptIndex 以降の Final のみ）
      ↓
Live Minutes 更新（新規ブロック追記。同一論点の継続のみ直前ブロックを更新）
      ↓
Meeting State 更新（Rolling Summary・決定・Action・未決）
      ↓
Meeting Advisor 更新（全体置き換え）
```

- Transcript 全文を毎回送ることはしません。LLM 入力は **Context + Rolling Summary + 直近の議事ブロック + 新規 Transcript（+ Notes 末尾）** が中心で、各要素に文字数上限があります
- 新規 Transcript が多い場合（LLM 障害からの復帰時など）は上限で分割し、続きは数秒後に処理します
- 前回リクエスト実行中は次を開始しません。一時停止中・新規発言なしの場合は呼び出しません
- エラー時は処理済み位置を進めず次回に再試行します（Transcript は失われません）。レート制限（429）時は Retry-After（最低 60 秒）待機、連続エラー時は指数バックオフします
- 元の Transcript は削除せず、議事録・Snapshot に全件出力します
- 最終議事録では、Transcript が一定量（約 4 万文字）以下なら全文を、それ以上なら議事ブロック未反映分のみを LLM に渡し、Transcript 全文はアプリ側で議事録末尾に機械的に付与します

---

## Context フォーマット

Markdown（UTF-8）の見出し `##` 単位で解析します（未登録時に Download すると以下の標準テンプレートが出力されます）。

```markdown
# Meeting Context

## 会議名

## 出席者

## 目的

## 使用者の役割

## アジェンダ

## 想定論点

## 想定確認事項

## 想定QA

## アドバイスにおける留意点

## その他メモ
```

任意項目:

```markdown
## 想定会議時間
60分
```

- アプリ内部では raw Markdown を正として保持し、見出しを `meetingName / attendees / purpose / userRole / agenda / issues / confirmationItems / anticipatedQA / adviceNotes / otherNotes / meetingDuration` に構造化して利用します
- 箇条書き（`-` / `1.`）はリスト項目として解析します
- 想定QA は `Q. 質問` / `A. 回答`（`Q:` `Q1.` `質問：` `回答：` も可）または `### 質問` 見出し＋本文の形式で記載します
- 想定会議時間は「60分」「1時間30分」「1.5時間」「90 min」等を解釈します（なければ設定値）
- 見出しを認識できない自由形式のテキストでも、本文全体を Context として LLM に渡します
- 記入例: `sample/context-example.md`、記入ガイド付きテンプレート: `sample/context-template.md`

---

## Recognition Dictionary（誤認識辞書）フォーマット

```csv
from,to
インダストリーワン,Industry One
クロードコード,Claude Code
オープンエーアイ,OpenAI
```

- UTF-8（BOM あり / なし両対応）。Download 時は Excel での文字化け防止のため BOM 付きで出力します
- 1 行目の `from,to` ヘッダーは省略可。`#` で始まる行はコメント。カンマや改行を含む値はダブルクォートで囲みます
- 音声認識の **Final Result 確定後** に、LLM ではなく機械的な文字列置換を行います
- **from の文字数が長いものから優先**し、1 パスで置換します（置換結果がさらに別ルールで置換されることはありません）
- 同じ from が複数ある場合は後の行が優先されます
- 辞書が空の状態で Download するとサンプル付き CSV を出力します
- Upload した辞書は即座に LocalStorage へ保存されます。画面上の CSV 編集は「保存」で反映されます

---

## データ保存場所

すべて **このブラウザの LocalStorage**（オリジン単位）に保存され、外部サーバーへは送信されません（LLM API 呼び出しを除く）。

| キー | 内容 |
|---|---|
| `lma.settings.v1` | 設定（speech / llm（API Key 含む）/ recognitionDictionary / preferences） |
| `lma.context.v1` | Context（raw Markdown） |
| `lma.session.v1` | 自動保存された会議データ（Transcript / Live Minutes / Advisor / Notes 等） |

設定の保存形式（概要）:

```json
{
  "speech": { "engine": "webspeech", "language": "auto", "inputMode": "microphone", "microphoneDeviceId": "" },
  "llm": { "provider": "openai", "baseUrl": "...", "apiKey": "...", "model": "...", "profiles": { "openai": {}, "gemini": {} } },
  "recognitionDictionary": [{ "from": "...", "to": "..." }],
  "preferences": { "meetingDuration": 60, "updateInterval": 60 }
}
```

- 設定が破損していた場合はデフォルトに戻し（破損データは `lma.settings.v1.corrupt` に退避）、画面に通知します
- 設定 → 会議 →「保存データをすべて削除」で上記キーを一括削除できます
- LocalStorage の容量（約 5MB）を超えた場合は自動保存できない旨を通知します。長時間会議では適宜「保存」で HTML Snapshot を出力してください

---

## セキュリティ上の注意

- **API Key をブラウザ（LocalStorage）に保存する方式は MVP・ローカル利用向けであり、本番用途には不適切です。** 同じ PC・ブラウザプロファイルを使う人や、ブラウザ拡張機能から読み取られる可能性があります
- **本番化する場合は Backend / API Proxy を用意し、API Key はサーバー側で保持してください。** LLM 呼び出しは `LLMProvider` インターフェース（`js/llm-provider.js`）に集約しているため、Proxy を呼ぶ Provider を追加して `js/llm-service.js` の registry に登録すれば差し替えられます
- **System Audio 共有時は、共有対象（タブ・画面）に機密情報が含まれ得ます。** 共有するのは必要な対象だけにしてください（本アプリは映像を使用しませんが、ブラウザの共有状態は維持されます）
- **Transcript / Context / Notes には機密情報が含まれ得ます。** これらは LLM Provider に送信されます。利用する LLM サービスのデータ取り扱い規約を確認してください
- **HTML Snapshot・Markdown 議事録には API Key を含めません。** 画面 DOM をそのまま保存せず、エクスポート専用のデータオブジェクト（許可した項目のみ）から生成し、出力直前に API Key と一致する文字列が含まれていないかを検査します（含まれていれば出力を中止）。Base URL・マイクのデバイス ID も出力しません
- LLM 出力・Transcript は `innerHTML` を使わず `textContent` / DOM API で描画します。Markdown も独自の安全なレンダラで DOM を構築し、リンクは http / https のみ許可します
- `index.html` は Content Security Policy でスクリプトを自ホストのみに制限しています。Snapshot はスクリプトを一切実行しない CSP 付きの静的 HTML です
- LLM の出力は誤りを含む可能性があります。決定事項・担当者・期限は必ず人が確認してください

---

## 既知のブラウザ制約

- **Web Speech API**: Chrome / Edge の音声認識はブラウザベンダーのクラウドサービスを利用するため、ネットワーク接続が必要で、音声がブラウザベンダーへ送信されます。無音が続いた場合などにブラウザ側で認識セッションが終了することがあり、本アプリは Listening 中のみ自動再開します（連続失敗時はバックオフし、致命的エラー時は Error 状態で停止）
- **言語の Auto** は音声からの自動言語判定ではありません（HTML lang → ブラウザ言語 → ja-JP）。本アプリの HTML lang は `ja` のため、Auto は通常 ja-JP になります。会議中の言語変更は即時反映（認識を再起動）されます
- **話者分離** は行いません
- **System Audio**: OS の出力デバイスを直接キャプチャすることはできません。ウィンドウ共有では音声が取得できないことが多く、macOS では画面全体共有でもシステム音声を共有できない場合があります（タブ共有を推奨）
- **音声トラック直接入力** に未対応のブラウザでは System Audio を認識できず、マイク認識にフォールバックします（上記参照）
- 入力モード・マイクの変更は「一時停止」→「再開」で反映されます
- ブラウザのタブがバックグラウンドの場合、タイマー精度が下がることがあります
- 端末の Linux 環境などでロケールが UTF-8 でない場合、日本語ファイル名のダウンロードが `download` という名前になることがあります（通常の Windows / macOS では問題ありません）

---

## 開発メモ

- URL に `?debug=1` を付けると `window.__lmaDebug` が公開され、`injectFinal('テキスト')`（確定発言の投入）や `simulateListening()`（音声デバイスなしで Listening 状態を再現）、`runCycle()` などで LLM 連携を検証できます
- 新しい STT エンジンは `SpeechEngine`（`js/speech-service.js`）を継承し `createSpeechEngine` に登録します
- 新しい LLM Provider は `LLMProvider`（`js/llm-provider.js`）を継承し `generate({ systemPrompt, userPrompt, responseFormat })` を実装して `registerProvider()` で登録します

## License

MIT（LICENSE 参照）
