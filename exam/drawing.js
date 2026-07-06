/* =====================================================================
 *  DrawPad — 解答用ベクター図形エディタ
 *  対応図形: 矩形(□) / 楕円(◯) / 直線 / 矢印 / 文字
 *  線色: 黒 / 赤、塗り: 透明
 *  操作: 選択移動 / 削除 / 元に戻す / 全消去
 *  ユースケース図・E-R図・クラス図・PERT図・シーケンス図・V字モデル等の作図に使用
 * ===================================================================== */
(function (global) {
  "use strict";

  const TOOLS = [
    { id: "select", label: "選択/移動/変形", icon: "↖" },
    { id: "rect",   label: "□ 四角",   icon: "▭" },
    { id: "ellipse",label: "◯ 円",     icon: "◯" },
    { id: "line",   label: "直線",      icon: "／" },
    { id: "arrow",  label: "矢印",      icon: "→" },
    { id: "text",   label: "文字",      icon: "A" },
  ];

  class DrawPad {
    constructor(container, opts = {}) {
      this.height = opts.height || 420;
      this.shapes = [];
      this.history = [];
      this.tool = "rect";
      this.color = "#000";
      this.sel = -1;        // 選択中shape index
      this.clip = null;     // コピー＆ペースト用クリップボード（shape の複製）
      this.pasteN = 0;      // 連続貼り付け時のオフセット段数
      this.onChange = opts.onChange || function () {};
      // 事前描画テンプレ（locked図形）。未保存時のみ表示され、保存解答があれば fromJSON で上書きされる
      this.template = Array.isArray(opts.template) ? opts.template : null;
      if (this.template) this.shapes = JSON.parse(JSON.stringify(this.template));
      this._build(container);
      this.resize();
      this.render();
      // 生成時に detached（幅0）でも、DOM追加・全画面化・リサイズで自動的に再フィット
      if (window.ResizeObserver) {
        this._ro = new ResizeObserver(() => { this.resize(); this.render(); });
        this._ro.observe(this.stage);
      }
      window.addEventListener("resize", () => { this.resize(); this.render(); });
    }

    /* ---------- UI 構築 ---------- */
    _build(container) {
      const wrap = document.createElement("div");
      wrap.className = "drawpad";

      const bar = document.createElement("div");
      bar.className = "drawbar";

      // 図形ツール
      TOOLS.forEach((t) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "dtool";
        b.dataset.tool = t.id;
        b.title = t.label;
        b.innerHTML = `<span class="di">${t.icon}</span><span class="dt">${t.label}</span>`;
        b.onclick = () => this.setTool(t.id);
        bar.appendChild(b);
      });

      const sep1 = document.createElement("span"); sep1.className = "dsep"; bar.appendChild(sep1);

      // 色
      [["#000", "黒"], ["#d00", "赤"]].forEach(([c, name]) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "dcolor";
        b.dataset.color = c;
        b.title = name;
        b.style.background = c;
        b.onclick = () => this.setColor(c);
        bar.appendChild(b);
      });

      const sep2 = document.createElement("span"); sep2.className = "dsep"; bar.appendChild(sep2);

      // 操作
      const mkbtn = (label, fn, title) => {
        const b = document.createElement("button");
        b.type = "button"; b.className = "daction"; b.textContent = label;
        if (title) b.title = title;
        b.onclick = fn; bar.appendChild(b); return b;
      };
      mkbtn("コピー", () => this.copySelected(), "選択中の図形をコピー（⌘/Ctrl+C）");
      mkbtn("貼り付け", () => this.paste(), "コピーした図形を貼り付け（⌘/Ctrl+V）");
      mkbtn("削除", () => this.deleteSelected(), "選択中の図形を削除");
      mkbtn("元に戻す", () => this.undo(), "直前の操作を取り消し");
      mkbtn("全消去", () => this.clearAll(), "すべて消去");

      // キャンバス
      const stage = document.createElement("div");
      stage.className = "drawstage";
      stage.style.height = this.height + "px";
      const canvas = document.createElement("canvas");
      stage.appendChild(canvas);

      // 文字入力用オーバーレイ
      const tin = document.createElement("input");
      tin.type = "text";
      tin.className = "dtextinput";
      tin.style.display = "none";
      stage.appendChild(tin);

      wrap.appendChild(bar);
      wrap.appendChild(stage);
      container.appendChild(wrap);

      this.wrap = wrap; this.bar = bar; this.stage = stage;
      this.canvas = canvas; this.ctx = canvas.getContext("2d");
      this.textInput = tin;

      this._bindEvents();
      this._refreshToolbar();
    }

    _refreshToolbar() {
      this.bar.querySelectorAll(".dtool").forEach((b) =>
        b.classList.toggle("active", b.dataset.tool === this.tool));
      this.bar.querySelectorAll(".dcolor").forEach((b) =>
        b.classList.toggle("active", b.dataset.color === this.color));
    }

    setTool(t) {
      this.tool = t; this.sel = -1; this._refreshToolbar(); this.render();
      this.canvas.style.cursor = (t === "select") ? "default" : "crosshair";
    }
    setColor(c) { this.color = c; this._refreshToolbar();
      if (this.sel >= 0) { this._snapshot(); this.shapes[this.sel].color = c; this.render(); this._emit(); } }

    /* ---------- 座標・サイズ ---------- */
    resize() {
      const dpr = window.devicePixelRatio || 1;
      const w = this.stage.clientWidth;
      const h = this.height;
      this.canvas.width = w * dpr;
      this.canvas.height = h * dpr;
      this.canvas.style.width = w + "px";
      this.canvas.style.height = h + "px";
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.W = w; this.H = h;
    }

    _pos(e) {
      const r = this.canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    /* ---------- イベント ---------- */
    _bindEvents() {
      const c = this.canvas;
      c.addEventListener("pointerdown", (e) => this._down(e));
      c.addEventListener("pointermove", (e) => this._move(e));
      c.addEventListener("pointerup", (e) => this._up(e));
      c.addEventListener("dblclick", (e) => this._dblclick(e));
      // 削除キー（キャンバスにフォーカスがある時）
      c.tabIndex = 0;
      c.addEventListener("keydown", (e) => {
        const mod = e.metaKey || e.ctrlKey;       // ⌘(Mac) / Ctrl(Win)
        if (mod && (e.key === "c" || e.key === "C")) {
          if (this.sel >= 0) { e.preventDefault(); this.copySelected(); }
          return;
        }
        if (mod && (e.key === "v" || e.key === "V")) {
          if (this.clip) { e.preventDefault(); this.paste(); }
          return;
        }
        if (mod && (e.key === "d" || e.key === "D")) {   // 複製（コピー＋即貼り付け）
          if (this.sel >= 0) { e.preventDefault(); this.duplicate(); }
          return;
        }
        if ((e.key === "Delete" || e.key === "Backspace") && this.sel >= 0) {
          e.preventDefault(); this.deleteSelected();
        }
      });
    }

    _down(e) {
      const p = this._pos(e);

      if (this.tool === "text") {
        // キャンバスへフォーカスが奪われて入力欄が即blurするのを防ぐ（focusは次tickで）
        e.preventDefault();
        const hit = this._hitTest(p);
        if (hit >= 0 && this.shapes[hit].type === "text") {
          const s = this.shapes[hit];            // 既存の文字をクリック → その場で再編集
          this._openTextInput(s.x, s.y, s, hit);
        } else {
          this._openTextInput(p.x, p.y);         // 新規入力
        }
        this.start = null;
        return;
      }
      this.canvas.setPointerCapture(e.pointerId);
      this.start = p;

      if (this.tool === "select") {
        // すでに選択中の図形のハンドル上なら「リサイズ」開始
        if (this.sel >= 0) {
          const hid = this._handleAt(p);
          if (hid) {
            this._snapshot();
            this.resizing = hid; this.moved = false; this.dragOff = p;
            return;
          }
        }
        const hit = this._hitTest(p);
        this.sel = hit;
        if (hit >= 0) {
          this._snapshot();
          this.dragging = true;
          this.dragOff = p;
          this.moved = false;
        }
        this.render();
        return;
      }
      // 図形作成
      this.draft = this._newShape(this.tool, p);
    }

    _move(e) {
      const p = this._pos(e);

      // 選択ツールでハンドル上にカーソルがあれば、リサイズ用カーソルに変える
      if (this.tool === "select" && !this.dragging && !this.resizing && !this.draft) {
        const hid = this.sel >= 0 ? this._handleAt(p) : null;
        this.canvas.style.cursor = hid ? this._cursorFor(hid) : "default";
      }

      if (!this.start && !this.dragging && !this.resizing) return;

      if (this.resizing && this.sel >= 0) {     // 大きさ・長さの調整
        this._resize(this.shapes[this.sel], this.resizing, p);
        this.moved = true; this.render();
        return;
      }
      if (this.dragging && this.sel >= 0) {
        const dx = p.x - this.dragOff.x;
        const dy = p.y - this.dragOff.y;
        this._translate(this.shapes[this.sel], dx, dy);
        this.dragOff = p; this.moved = true;
        this.render();
        return;
      }
      if (this.draft) {
        this._updateShape(this.draft, this.start, p);
        this.render(this.draft);
      }
    }

    _up(e) {
      if (this.draft) {
        // 小さすぎる図形は破棄
        if (this._isMeaningful(this.draft)) {
          this._snapshot();
          this.shapes.push(this.draft);
          this._emit();
        }
        this.draft = null;
      }
      if (this.resizing) {
        this.resizing = null;
        if (this.moved) this._emit();
      }
      if (this.dragging) {
        this.dragging = false;
        if (this.moved) this._emit();
      }
      this.start = null;
      this.render();
    }

    /* ---------- リサイズ用ハンドル ---------- */
    _handles(s) {
      if (s.type === "line" || s.type === "arrow") {
        return [{ id: "p1", x: s.x1, y: s.y1 }, { id: "p2", x: s.x2, y: s.y2 }];
      }
      if (s.type === "rect" || s.type === "ellipse") {
        const l = s.x, t = s.y, r = s.x + s.w, b = s.y + s.h, cx = s.x + s.w / 2, cy = s.y + s.h / 2;
        return [
          { id: "nw", x: l, y: t }, { id: "n", x: cx, y: t }, { id: "ne", x: r, y: t },
          { id: "e", x: r, y: cy }, { id: "se", x: r, y: b }, { id: "s", x: cx, y: b },
          { id: "sw", x: l, y: b }, { id: "w", x: l, y: cy },
        ];
      }
      return [];
    }
    _handleAt(p) {
      if (this.sel < 0) return null;
      const hs = this._handles(this.shapes[this.sel]);
      for (let i = 0; i < hs.length; i++) {
        if (Math.abs(p.x - hs[i].x) <= 7 && Math.abs(p.y - hs[i].y) <= 7) return hs[i].id;
      }
      return null;
    }
    _resize(s, id, p) {
      if (s.type === "line" || s.type === "arrow") {
        if (id === "p1") { s.x1 = p.x; s.y1 = p.y; } else { s.x2 = p.x; s.y2 = p.y; }
        return;
      }
      let l = s.x, t = s.y, r = s.x + s.w, b = s.y + s.h;
      if (id.indexOf("w") >= 0) l = p.x;
      if (id.indexOf("e") >= 0) r = p.x;
      if (id.indexOf("n") >= 0) t = p.y;
      if (id.indexOf("s") >= 0) b = p.y;
      s.x = Math.min(l, r); s.y = Math.min(t, b); s.w = Math.abs(r - l); s.h = Math.abs(b - t);
    }
    _cursorFor(id) {
      if (id === "p1" || id === "p2") return "crosshair";
      return ({ nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize",
        n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize" })[id] || "pointer";
    }

    _dblclick(e) {
      // 文字をダブルクリックで再編集
      const p = this._pos(e);
      const hit = this._hitTest(p);
      if (hit >= 0 && this.shapes[hit].type === "text") {
        const s = this.shapes[hit];
        this._openTextInput(s.x, s.y, s, hit);
      }
    }

    /* ---------- 図形生成・更新 ---------- */
    _newShape(type, p) {
      const base = { type, color: this.color };
      if (type === "rect" || type === "ellipse")
        return Object.assign(base, { x: p.x, y: p.y, w: 0, h: 0 });
      return Object.assign(base, { x1: p.x, y1: p.y, x2: p.x, y2: p.y });
    }
    _updateShape(s, a, b) {
      if (s.type === "rect" || s.type === "ellipse") {
        s.x = Math.min(a.x, b.x); s.y = Math.min(a.y, b.y);
        s.w = Math.abs(b.x - a.x); s.h = Math.abs(b.y - a.y);
      } else { s.x2 = b.x; s.y2 = b.y; }
    }
    _isMeaningful(s) {
      if (s.type === "rect" || s.type === "ellipse") return s.w > 5 || s.h > 5;
      return Math.hypot(s.x2 - s.x1, s.y2 - s.y1) > 5;
    }
    _translate(s, dx, dy) {
      if (s.type === "rect" || s.type === "ellipse" || s.type === "text") { s.x += dx; s.y += dy; }
      else { s.x1 += dx; s.y1 += dy; s.x2 += dx; s.y2 += dy; }
    }

    /* ---------- 文字入力 ---------- */
    _openTextInput(x, y, existing, idx) {
      const tin = this.textInput;
      tin.style.display = "block";
      tin.style.left = x + "px";
      tin.style.top = (y - 12) + "px";
      tin.style.color = existing ? existing.color : this.color;
      tin.value = existing ? existing.text : "";
      // クリック直後のフォーカス奪取を避けるため、次tickでフォーカス
      setTimeout(() => { tin.focus(); tin.select(); }, 0);
      const commit = () => {
        tin.style.display = "none";
        const v = tin.value.trim();
        tin.onblur = null; tin.onkeydown = null;
        if (existing) {
          this._snapshot();
          if (v) existing.text = v; else this.shapes.splice(idx, 1);
          this.render(); this._emit();
        } else if (v) {
          this._snapshot();
          this.shapes.push({ type: "text", x, y, text: v, color: this.color });
          this.render(); this._emit();
        }
      };
      tin.onblur = commit;
      tin.onkeydown = (ev) => {
        ev.stopPropagation();   // キャンバスのDelete/Backspace等へ伝播させない
        if (ev.key === "Enter") { ev.preventDefault(); commit(); }
        else if (ev.key === "Escape") { ev.preventDefault(); tin.style.display = "none"; tin.onblur = null; tin.onkeydown = null; }
      };
    }

    /* ---------- ヒットテスト ---------- */
    _hitTest(p) {
      for (let i = this.shapes.length - 1; i >= 0; i--) {
        if (this.shapes[i].locked) continue;   // テンプレ枠は選択・移動・削除の対象外
        if (this._hit(this.shapes[i], p)) return i;
      }
      return -1;
    }
    _hit(s, p) {
      const t = 6;
      if (s.type === "rect" || s.type === "ellipse")
        return p.x >= s.x - t && p.x <= s.x + s.w + t && p.y >= s.y - t && p.y <= s.y + s.h + t;
      if (s.type === "text") {
        this.ctx.font = "16px sans-serif";
        const w = this.ctx.measureText(s.text).width;
        return p.x >= s.x - t && p.x <= s.x + w + t && p.y >= s.y - 18 && p.y <= s.y + 6;
      }
      // line / arrow: 線分との距離
      return this._distToSeg(p, s) < 8;
    }
    _distToSeg(p, s) {
      const A = p.x - s.x1, B = p.y - s.y1, C = s.x2 - s.x1, D = s.y2 - s.y1;
      const dot = A * C + B * D, len = C * C + D * D;
      let t = len ? dot / len : 0; t = Math.max(0, Math.min(1, t));
      const xx = s.x1 + t * C, yy = s.y1 + t * D;
      return Math.hypot(p.x - xx, p.y - yy);
    }

    /* ---------- 描画 ---------- */
    render(draft) {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.W, this.H);
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, this.W, this.H);
      this.shapes.forEach((s, i) => this._draw(s, i === this.sel));
      if (draft) this._draw(draft, false);
    }
    _draw(s, selected) {
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = s.color; ctx.fillStyle = s.color;
      ctx.lineWidth = 2; ctx.lineCap = "round"; ctx.lineJoin = "round";
      if (s.type === "rect") { ctx.strokeRect(s.x, s.y, s.w, s.h); }
      else if (s.type === "ellipse") {
        ctx.beginPath();
        ctx.ellipse(s.x + s.w / 2, s.y + s.h / 2, Math.abs(s.w / 2), Math.abs(s.h / 2), 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (s.type === "line" || s.type === "arrow") {
        ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke();
        if (s.type === "arrow") this._arrowHead(ctx, s);
      } else if (s.type === "text") {
        ctx.font = "16px 'Hiragino Kaku Gothic ProN','Yu Gothic',sans-serif";
        ctx.textBaseline = "alphabetic";
        ctx.fillText(s.text, s.x, s.y);
      }
      ctx.restore();
      if (selected) this._drawSel(s);
    }
    _arrowHead(ctx, s) {
      const ang = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
      const len = 12;
      ctx.beginPath();
      ctx.moveTo(s.x2, s.y2);
      ctx.lineTo(s.x2 - len * Math.cos(ang - Math.PI / 7), s.y2 - len * Math.sin(ang - Math.PI / 7));
      ctx.moveTo(s.x2, s.y2);
      ctx.lineTo(s.x2 - len * Math.cos(ang + Math.PI / 7), s.y2 - len * Math.sin(ang + Math.PI / 7));
      ctx.stroke();
    }
    _drawSel(s) {
      const ctx = this.ctx, m = 4;
      let x, y, w, h;
      if (s.type === "rect" || s.type === "ellipse") { x = s.x; y = s.y; w = s.w; h = s.h; }
      else if (s.type === "text") {
        ctx.font = "16px sans-serif";
        const tw = ctx.measureText(s.text).width;
        x = s.x; y = s.y - 16; w = tw; h = 20;
      } else {
        x = Math.min(s.x1, s.x2); y = Math.min(s.y1, s.y2);
        w = Math.abs(s.x2 - s.x1); h = Math.abs(s.y2 - s.y1);
      }
      ctx.save();
      ctx.strokeStyle = "#1a73e8"; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
      ctx.strokeRect(x - m, y - m, w + m * 2, h + m * 2);
      // リサイズ用ハンドル（白四角・青枠）
      ctx.setLineDash([]); ctx.lineWidth = 1.5;
      this._handles(s).forEach((hd) => {
        ctx.fillStyle = "#fff"; ctx.strokeStyle = "#1a73e8";
        ctx.beginPath(); ctx.rect(hd.x - 4, hd.y - 4, 8, 8); ctx.fill(); ctx.stroke();
      });
      ctx.restore();
    }

    /* ---------- 履歴・操作 ---------- */
    _snapshot() { this.history.push(JSON.stringify(this.shapes)); if (this.history.length > 50) this.history.shift(); }
    undo() {
      if (!this.history.length) return;
      this.shapes = JSON.parse(this.history.pop());
      this.sel = -1; this.render(); this._emit();
    }
    deleteSelected() {
      if (this.sel < 0) return;
      this._snapshot(); this.shapes.splice(this.sel, 1); this.sel = -1; this.render(); this._emit();
    }

    /* ---------- コピー＆ペースト ---------- */
    copySelected() {
      if (this.sel < 0) return;
      this.clip = JSON.parse(JSON.stringify(this.shapes[this.sel])); // 深いコピー
      this.pasteN = 0;  // 次の貼り付けは1段ずらしから
    }
    paste() {
      if (!this.clip) return;
      this._snapshot();
      const s = JSON.parse(JSON.stringify(this.clip));
      this.pasteN += 1;
      const d = 16 * this.pasteN;          // 連続貼り付けで重ならないようずらす
      this._translate(s, d, d);
      this.shapes.push(s);
      // 貼り付けた図形を選択状態にして、すぐ動かせるよう選択ツールへ
      this.tool = "select"; this._refreshToolbar();
      this.canvas.style.cursor = "default";
      this.sel = this.shapes.length - 1;
      this.render(); this._emit();
    }
    duplicate() {            // 選択図形をその場で複製
      if (this.sel < 0) return;
      this.copySelected(); this.paste();
    }
    clearAll() {
      if (!this.shapes.length) return;
      this._confirmInline("この図をすべて消去しますか？").then((ok) => {
        if (!ok) return;
        this._snapshot(); this.shapes = this.shapes.filter((s) => s.locked); this.sel = -1; this.render(); this._emit();
      });
    }

    _confirmInline(message) {
      return new Promise((resolve) => {
        const o = document.createElement("div");
        o.className = "overlay";
        o.style.cssText = "position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(13,27,62,.82)";
        o.innerHTML =
          '<div class="card" style="background:#1e2a45;color:#e6ebff;border-radius:14px;padding:32px 28px;max-width:420px;width:90%;text-align:center">' +
          '<p style="font-size:16px;margin:0 0 20px">' + message.replace(/</g, "&lt;").replace(/>/g, "&gt;") + "</p>" +
          '<div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">' +
          '<button id="dpCfYes" class="startbtn" style="background:#c0392b;color:#fff;font-size:15px;padding:10px 24px">消去する</button>' +
          '<button id="dpCfNo" class="startbtn" style="background:#6b7480;color:#fff;font-size:15px;padding:10px 24px">キャンセル</button>' +
          "</div></div>";
        document.body.appendChild(o);
        const done = (val) => { o.remove(); resolve(val); };
        o.querySelector("#dpCfYes").addEventListener("click", () => done(true));
        o.querySelector("#dpCfNo").addEventListener("click", () => done(false));
      });
    }

    /* ---------- 入出力 ---------- */
    _emit() { this.onChange(); }
    isEmpty() { return this.shapes.length === 0; }
    toJSON() { return this.shapes; }
    fromJSON(arr) { this.shapes = Array.isArray(arr) ? arr : []; this.sel = -1; this.render(); }
    toPNG() {
      // 選択枠なしで書き出し
      const sel = this.sel; this.sel = -1; this.render();
      const url = this.canvas.toDataURL("image/png");
      this.sel = sel; this.render();
      return url;
    }
  }

  global.DrawPad = DrawPad;
})(window);
