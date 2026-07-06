/* =====================================================================
 *  admin/apiClient.js — ExamForge 教員アプリ共通APIクライアント
 *
 *  実装指示書§4 P3-1（ApiClient・AdminSession）・§7.1 API action一覧・
 *  内部設計書§3.2 ApiClient/AdminSession クラス図を実装根拠とする。
 *
 *  責務:
 *   - GAS_ENDPOINT / ADMIN_TOKEN の sessionStorage 保持（FR-F02。明示ログアウトで消去）
 *   - callGet/callPost の共通実装（fetch→失敗時JSONPフォールバック。実装指示書A-3）
 *   - 全呼出しへの token=ADMIN_TOKEN 付与
 *   - {ok:false,error:"ERR_AUTH"} 受信時のログイン画面誘導（§8 E-09）
 *
 *  他の admin/*.js は本ファイルにのみ依存する（相互import禁止。実装指示書§9）。
 * ===================================================================== */
(function (global) {
  "use strict";

  var SS_KEY_ENDPOINT = "ef_gas";   // sessionStorage: GAS_ENDPOINT
  var SS_KEY_TOKEN = "ef_admin";    // sessionStorage: ADMIN_TOKEN（ブラウザ内保持のみ。FR-F02）

  // ===== AdminSession: 認証情報の保持（sessionStorageのみ。リポジトリ内ファイルに値を書かない） =====

  var AdminSession = {
    getEndpoint: function () {
      try { return sessionStorage.getItem(SS_KEY_ENDPOINT) || ""; } catch (e) { return ""; }
    },
    getToken: function () {
      try { return sessionStorage.getItem(SS_KEY_TOKEN) || ""; } catch (e) { return ""; }
    },
    save: function (endpoint, token) {
      try {
        sessionStorage.setItem(SS_KEY_ENDPOINT, endpoint || "");
        sessionStorage.setItem(SS_KEY_TOKEN, token || "");
      } catch (e) { /* sessionStorage不可時は無視（ページ内変数にも保持されないため再ログインが必要） */ }
    },
    isLoggedIn: function () {
      return !!(this.getEndpoint() && this.getToken());
    },
    // 明示ログアウトで消去（FR-F02）
    logout: function () {
      try {
        sessionStorage.removeItem(SS_KEY_ENDPOINT);
        sessionStorage.removeItem(SS_KEY_TOKEN);
      } catch (e) { /* noop */ }
    }
  };

  // ===== JSONPフォールバック（exam.js の jsonp と同一方式。実装指示書A-3・§8.1 L900-912転用） =====
  function jsonp_(baseUrl) {
    return new Promise(function (resolve, reject) {
      var cb = "efAdminCb_" + Math.random().toString(36).slice(2);
      var s = document.createElement("script");
      var timer = setTimeout(function () { cleanup(); reject(new Error("timeout")); }, 15000);
      function cleanup() {
        try { delete global[cb]; } catch (e) { global[cb] = undefined; }
        if (s.parentNode) s.parentNode.removeChild(s);
        clearTimeout(timer);
      }
      global[cb] = function (data) { cleanup(); resolve(data); };
      s.onerror = function () { cleanup(); reject(new Error("script error")); };
      s.src = baseUrl + "&callback=" + cb + "&t=" + Date.now();
      document.head.appendChild(s);
    });
  }

  function qs_(params) {
    var parts = [];
    for (var k in params) {
      if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
      if (params[k] === undefined || params[k] === null) continue;
      parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
    }
    return parts.join("&");
  }

  // ERR_AUTH受信時にログイン画面へ誘導する（§8 E-09）。index.html以外の画面から呼ばれる想定。
  function redirectToLoginIfAuthError_(res) {
    if (res && res.ok === false && res.error === "ERR_AUTH") {
      AdminSession.logout();
      var here = location.pathname.split("/").pop();
      if (here !== "index.html" && here !== "") {
        location.href = "index.html";
      }
    }
    return res;
  }

  /**
   * callGet(action, params): GET呼出し。fetch失敗時はJSONPへフォールバック（実装指示書A-3）。
   * token=ADMIN_TOKENを自動付与。action==="ping"のみtoken省略可（未ログイン接続テスト用）。
   */
  function callGet(action, params, opts) {
    opts = opts || {};
    var endpoint = opts.endpoint || AdminSession.getEndpoint();
    var token = opts.token !== undefined ? opts.token : AdminSession.getToken();
    var merged = Object.assign({}, params || {}, { action: action });
    if (action !== "ping") merged.token = token;
    var url = endpoint + "?" + qs_(merged);

    return fetch(url, { method: "GET" })
      .then(function (r) { return r.json(); })
      .catch(function () {
        return jsonp_(url); // fetch失敗（CORS等）時のみJSONP
      })
      .then(redirectToLoginIfAuthError_);
  }

  /**
   * callPost(action, body): POST呼出し（text/plain単純リクエスト。実装指示書A-3）。
   * 応答JSONをparseする。token=ADMIN_TOKENを自動付与。
   */
  function callPost(action, body, opts) {
    opts = opts || {};
    var endpoint = opts.endpoint || AdminSession.getEndpoint();
    var token = opts.token !== undefined ? opts.token : AdminSession.getToken();
    var payload = Object.assign({}, body || {}, { action: action, token: token });

    return fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json(); })
      .then(redirectToLoginIfAuthError_)
      .catch(function (err) {
        throw err; // POSTはJSONP化不可（ペイロードが大きい/actionがadmin.*でtoken必須のため呼出元でエラー処理）
      });
  }

  /**
   * exportCsv専用: JSON封筒でなくCSVテキストをそのまま返す（§7.3）。GETのみ。
   * fetchのみでJSONPは使わない（callback付与するとCSV応答形式と矛盾するため）。
   */
  function callGetCsv(params, opts) {
    opts = opts || {};
    var endpoint = opts.endpoint || AdminSession.getEndpoint();
    var token = opts.token !== undefined ? opts.token : AdminSession.getToken();
    var merged = Object.assign({}, params || {}, { action: "admin.exportCsv", token: token });
    var url = endpoint + "?" + qs_(merged);
    return fetch(url, { method: "GET" }).then(function (r) { return r.text(); });
  }

  /**
   * login(endpoint, token): pingで疎通確認→admin.listExamsでtoken検証→sessionStorageへ保存。
   * 実装指示書P3-1。成功時resolve、失敗時reject(reason)。
   */
  function login(endpoint, token) {
    var cleanEndpoint = (endpoint || "").trim();
    var cleanToken = (token || "").trim();
    if (!cleanEndpoint || !cleanToken) {
      return Promise.reject(new Error("GAS URLとADMIN_TOKENを入力してください。"));
    }
    return callGet("ping", {}, { endpoint: cleanEndpoint, token: cleanToken })
      .then(function (pingRes) {
        if (!pingRes || pingRes.ok !== true) {
          throw new Error("GAS_ENDPOINTに接続できませんでした。URLを確認してください。");
        }
        return callGet("admin.listExams", {}, { endpoint: cleanEndpoint, token: cleanToken });
      })
      .then(function (res) {
        if (!res || res.ok !== true) {
          throw new Error("ADMIN_TOKENが正しくありません。");
        }
        AdminSession.save(cleanEndpoint, cleanToken);
        return true;
      });
  }

  function logout() {
    AdminSession.logout();
  }

  global.ApiClient = {
    AdminSession: AdminSession,
    login: login,
    logout: logout,
    callGet: callGet,
    callPost: callPost,
    callGetCsv: callGetCsv
  };
})(window);
