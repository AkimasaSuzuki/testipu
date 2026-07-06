/* =====================================================================
 *  exam/config.js — ExamForge 受験アプリ設定
 *
 *  実装指示書§7.7（config.js契約）・内部設計書§9.1 を実装根拠とする。
 *  値はプレースホルダ（空文字/既定値）で作成し、setup/wizard.js が
 *  セットアップ完了時に実値を書き込む（GAS_ENDPOINT・SUBMIT_TOKEN・
 *  GOOGLE_OAUTH_CLIENT_ID等）。
 *
 *  管理トークンは本ファイルに絶対に含めない（FR-F02）。
 *  教員用の管理トークンは admin/ 側の sessionStorage にのみ保持し、
 *  本ファイル・公開リポジトリのいかなる場所にも書き込まない。
 * ===================================================================== */
window.EXAM_CONFIG = {
  // GASウェブアプリのデプロイURL。ウィザードがadmin.setupInit応答から自動設定（FR-A04）
  GAS_ENDPOINT: "",

  // 学生系API(questions/submit/status)の簡易トークン。弱い秘密・公開可（外部設計書NFR-08）
  // SetupService.generateToken_() が生成した値をウィザードが書き込む
  SUBMIT_TOKEN: "",

  // Google Identity Services 用クライアントID（教員が個人アカウントで発行し設定。公開情報）
  // 内部設計書§9.1・導入手順書v1.1§4.5参照
  GOOGLE_OAUTH_CLIENT_ID: "",

  // 表示・GISのhd(hosted_domain)ヒント用。ドメイン検証の権威値はGAS側(Script Properties)が持つ
  // （内部設計書§9.1「config.js側はhdヒント・表示用に格下げ」。クライアント値は偽装可能なため）
  ALLOWED_EMAIL_DOMAIN: "soka-u.jp",

  // 既定false：学生端末に解答・問題を残さない（FR-C06。SoftExpExam踏襲）
  KEEP_LOCAL_DOWNLOAD: false,

  // 保存失敗時フォールバック用 RSA-OAEP 公開鍵(JWK)。null=フォールバック無効
  // decrypt.html（admin/）で鍵ペアを生成し、公開鍵のみここに設定する
  ANSWER_PUBKEY: null,

  // 強制終了（背面化・全画面解除等）の許容回数。内部設計書§9.1（exam.js実績値）
  MAX_VIOLATIONS: 3,

  // 終了時刻到来時の自動提出ジッター幅（ミリ秒）。内部設計書§9.1・外部設計書FR-C11
  // 同時刻closeAtの学生が一斉送信しGASクォータを超えないよう、0〜この値の間で分散させる
  TIMEOUT_JITTER_MS: 10000,

  // 以下はローカル開発用オプション（exam.js継承機能。本番運用では未設定のままでよい）
  // FORCE_MONITORING: true にするとlocalhostでも全画面強制・背面監視を有効化する
  // SCHEDULE: {open, close} を指定するとwindow.EXAM直読み時のスケジュール判定に使う
};
