/* =====================================================================
 *  exam/googleAuth.js — GoogleAuthClient（学生ログイン）
 *
 *  内部設計書§3.1 GoogleAuthClientクラス・§3.1 hintボックス「FR-C12/C13
 *  学生Google OAuthログインの設計判断」・実装指示書P2-4 を実装根拠とする。
 *
 *  Google Identity Services (GIS) の1タップ/ボタンログインでIDトークンを
 *  取得しコールバックへ渡す。クライアント側ではドメイン判定・学籍番号抽出を
 *  一切行わない（すべてGAS側のAuth.verifyIdTokenAndResolveStudent()が権威。
 *  内部設計書§3.1「クライアント側の判定は常に偽装されうる」という不正対策の
 *  設計原則を認証にも一貫して適用）。
 *
 *  外部読み込みは https://accounts.google.com/gsi/client のみ（NFR-01）。
 * ===================================================================== */
(function (global) {
  "use strict";

  var GIS_SRC = "https://accounts.google.com/gsi/client";
  var gisLoadPromise = null;

  /** GISスクリプトを1回だけ動的ロードする。 */
  function loadGisScript() {
    if (gisLoadPromise) return gisLoadPromise;
    gisLoadPromise = new Promise(function (resolve, reject) {
      if (global.google && global.google.accounts && global.google.accounts.id) {
        resolve();
        return;
      }
      var existing = document.querySelector('script[src^="' + GIS_SRC + '"]');
      if (existing) {
        existing.addEventListener("load", function () { resolve(); });
        existing.addEventListener("error", function () { reject(new Error("gis_load_error")); });
        return;
      }
      var s = document.createElement("script");
      s.src = GIS_SRC;
      s.async = true;
      s.defer = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error("gis_load_error")); };
      document.head.appendChild(s);
    });
    return gisLoadPromise;
  }

  /**
   * IDトークンのペイロード部を表示用にのみdecodeする（署名検証は行わない）。
   * 内部設計書§3.1「decodeJwtPayloadはUI表示用の参考情報取得のみで、認可判定には使わない」
   */
  function decodeJwtPayload(idToken) {
    try {
      var parts = String(idToken || "").split(".");
      if (parts.length < 2) return null;
      var b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      while (b64.length % 4) b64 += "=";
      var json = decodeURIComponent(
        atob(b64).split("").map(function (c) {
          return "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2);
        }).join("")
      );
      return JSON.parse(json);
    } catch (e) {
      return null;
    }
  }

  /**
   * ログインボタンを指定要素に描画する。
   * @param {HTMLElement} el ボタンを描画するコンテナ要素
   * @param {function(string):void} onToken ログイン成功時にIDトークン文字列を渡すコールバック
   */
  function renderLoginButton(el, onToken) {
    var cfg = (global.EXAM_CONFIG) || {};
    loadGisScript().then(function () {
      global.google.accounts.id.initialize({
        client_id: cfg.GOOGLE_OAUTH_CLIENT_ID || "",
        hd: cfg.ALLOWED_EMAIL_DOMAIN || undefined, // 表示ヒントのみ。権威判定はGAS側（内部設計書§9.1）
        callback: function (resp) { onCredentialResponse(resp, onToken); },
        auto_select: false,
        itp_support: true,
      });
      global.google.accounts.id.renderButton(el, {
        type: "standard",
        theme: "filled_blue",
        size: "large",
        shape: "pill",
        text: "signin_with",
        logo_alignment: "left",
        width: (el && el.clientWidth) || 320,
      });
    }).catch(function () {
      if (el) {
        el.innerHTML = '<p style="color:#c00;font-size:13px">Googleログインの読み込みに失敗しました。通信環境を確認し、ページを再読み込みしてください。</p>';
      }
    });
  }

  /**
   * GISからの認証応答コールバック。取得したIDトークン文字列をそのまま呼び出し元へ渡す。
   * §3.1「onCredentialResponseで受け取ったIDトークン文字列をそのまま返す」
   */
  function onCredentialResponse(resp, onToken) {
    if (!resp || !resp.credential) return;
    if (typeof onToken === "function") onToken(resp.credential);
  }

  global.GoogleAuthClient = {
    renderLoginButton: renderLoginButton,
    decodeJwtPayload: decodeJwtPayload,
  };
})(window);
