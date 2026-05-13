'use strict';

/**
 * Inject / update / remove a visual "Navio is working" overlay into the guest
 * page's DOM.  The overlay is purely cosmetic (pointer-events: none) so it
 * never blocks the AI agent's sendInputEvent clicks or CDP actions.
 *
 * Used in WCV mode where the shell surface is below the tab WebContentsView
 * — shell-side overlays are invisible, so we inject directly into the page.
 */

const OVERLAY_ID = '__navio_agent_overlay__';

const OVERLAY_CSS = `
#${OVERLAY_ID} {
  position: fixed !important;
  inset: 0 !important;
  z-index: 2147483647 !important;
  pointer-events: none !important;
  display: flex !important;
  align-items: flex-start !important;
  justify-content: center !important;
  animation: __navio_fadeIn 0.28s ease-out both !important;
}
#${OVERLAY_ID}[hidden] { display: none !important; }

#${OVERLAY_ID} .__navio_border {
  position: absolute !important;
  inset: 0 !important;
  padding: 2.5px !important;
  pointer-events: none !important;
  background: conic-gradient(
    from var(--__navio_angle, 0deg),
    rgba(56,189,248,0.0) 0%,
    rgba(56,189,248,0.85) 12%,
    rgba(139,92,246,0.7) 25%,
    rgba(56,189,248,0.0) 40%,
    rgba(56,189,248,0.0) 100%
  ) !important;
  -webkit-mask:
    linear-gradient(#fff 0 0) content-box,
    linear-gradient(#fff 0 0) !important;
  -webkit-mask-composite: xor !important;
  mask:
    linear-gradient(#fff 0 0) content-box,
    linear-gradient(#fff 0 0) !important;
  mask-composite: exclude !important;
  animation: __navio_sweep 2.6s linear infinite !important;
}

@property --__navio_angle {
  syntax: '<angle>';
  initial-value: 0deg;
  inherits: false;
}
@keyframes __navio_sweep { to { --__navio_angle: 360deg; } }
@keyframes __navio_fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes __navio_orbSpin { to { transform: rotate(360deg); } }
@keyframes __navio_starPulse {
  0%,100% { opacity: 0.7; transform: scale(0.9); }
  50%     { opacity: 1;   transform: scale(1.1); }
}

#${OVERLAY_ID} .__navio_banner {
  position: relative !important;
  display: flex !important;
  align-items: center !important;
  gap: 10px !important;
  margin-top: 16px !important;
  padding: 8px 14px 8px 10px !important;
  background: rgba(15,17,23,0.92) !important;
  backdrop-filter: blur(16px) !important;
  -webkit-backdrop-filter: blur(16px) !important;
  border: 1px solid rgba(56,189,248,0.35) !important;
  border-radius: 10px !important;
  box-shadow: 0 4px 24px rgba(0,0,0,0.4), 0 0 30px rgba(56,189,248,0.08) !important;
  z-index: 2 !important;
  animation: __navio_fadeIn 0.32s ease-out both !important;
  user-select: none !important;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif !important;
}

#${OVERLAY_ID} .__navio_orb {
  position: relative !important;
  width: 28px !important;
  height: 28px !important;
  flex-shrink: 0 !important;
}
#${OVERLAY_ID} .__navio_orb_ring {
  position: absolute !important;
  inset: 0 !important;
  border-radius: 50% !important;
  border: 2px solid rgba(56,189,248,0.5) !important;
  border-top-color: transparent !important;
  border-right-color: rgba(139,92,246,0.6) !important;
  animation: __navio_orbSpin 2s linear infinite !important;
}
#${OVERLAY_ID} .__navio_orb_core {
  position: absolute !important;
  inset: 5px !important;
  border-radius: 50% !important;
  background: linear-gradient(135deg, rgba(56,189,248,0.25), rgba(139,92,246,0.2)) !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
}
#${OVERLAY_ID} .__navio_orb_core svg {
  width: 12px !important;
  height: 12px !important;
  color: rgba(56,189,248,0.9) !important;
  animation: __navio_starPulse 1.8s ease-in-out infinite !important;
}

#${OVERLAY_ID} .__navio_text {
  display: flex !important;
  flex-direction: column !important;
  gap: 1px !important;
}
#${OVERLAY_ID} .__navio_title {
  font-size: 12px !important;
  font-weight: 600 !important;
  color: #e2e8f0 !important;
  line-height: 1.3 !important;
}
#${OVERLAY_ID} .__navio_status {
  font-size: 11px !important;
  color: rgba(56,189,248,0.85) !important;
  line-height: 1.3 !important;
  white-space: nowrap !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  max-width: 280px !important;
}
#${OVERLAY_ID} .__navio_detail {
  display: none !important;
  font-size: 10px !important;
  font-weight: 500 !important;
  color: rgba(226,232,240,0.78) !important;
  line-height: 1.25 !important;
  max-width: 280px !important;
  white-space: nowrap !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
}
`.trim();

const OVERLAY_HTML = `
<div class="__navio_border"></div>
<div class="__navio_banner">
  <div class="__navio_orb">
    <div class="__navio_orb_ring"></div>
    <div class="__navio_orb_core">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
    </div>
  </div>
  <div class="__navio_text">
    <span class="__navio_title">Navio is working</span>
    <span class="__navio_status">Working\u2026</span>
    <span class="__navio_detail" hidden></span>
  </div>
</div>
`.trim();

const RIPPLE_STYLE_ID = '__navio_ripple_flash_style__';

const STATUS_LABELS = {
  navigate: 'Opening the page\u2026',
  read_page: 'Looking at the page\u2026',
  get_page_text: 'Pulling text\u2026',
  click: 'Clicking something\u2026',
  type_text: 'Filling something in\u2026',
  scroll: 'Scrolling\u2026',
  screenshot: 'Taking a screenshot\u2026',
  open_tab: 'Opening a tab\u2026',
  close_tab: 'Closing a tab\u2026',
  switch_tab: 'Switching tabs\u2026',
  wait: 'Waiting\u2026',
  pressKey: 'Pressing a key\u2026',
  insertText: 'Typing text\u2026',
  select_option: 'Selecting an option\u2026',
  go_forward: 'Going forward\u2026',
  go_back: 'Going back\u2026',
  gmail_search: 'Searching email\u2026',
  gmail_read: 'Reading email\u2026',
  gmail_send: 'Preparing email\u2026',
  run_workflow: 'Running a workflow\u2026',
  list_workflows: 'Checking workflows\u2026',
  web_search: 'Searching the web\u2026',
  thinking: 'Thinking with the model\u2026'
};

/** @type {WeakSet<import('electron').WebContents>} */
const _injected = new WeakSet();
/** @type {WeakMap<import('electron').WebContents, string>} CSS key returned by insertCSS */
const _cssKeys = new WeakMap();

/**
 * Inject the overlay into a guest WebContents.  Safe to call multiple times.
 * After navigation the DOM is replaced, so we always re-check if the overlay
 * element exists and re-create it if missing.
 */
async function injectAgentOverlay(wc) {
  if (!wc || wc.isDestroyed()) return;
  // Always (re-)insert CSS — after navigation the old CSS key is invalid
  try {
    const oldKey = _cssKeys.get(wc);
    if (oldKey) { try { await wc.removeInsertedCSS(oldKey); } catch { /* ignore */ } }
    const cssKey = await wc.insertCSS(OVERLAY_CSS);
    _cssKeys.set(wc, cssKey);
  } catch { /* ignore — page may not be ready */ }
  _injected.add(wc);
  try {
    const escapedHtml = JSON.stringify(OVERLAY_HTML);
    await wc.executeJavaScript(`
      (function(){
        if(document.getElementById('${OVERLAY_ID}')) return;
        var d=document.createElement('div');
        d.id='${OVERLAY_ID}';
        d.innerHTML=${escapedHtml};
        document.documentElement.appendChild(d);
      })()
    `);
  } catch { /* ignore */ }
}

/**
 * Update the status text on the injected overlay.
 * @param {string} [detailLine] — short subtitle (e.g. click target ref / field label); empty hides the line.
 */
async function updateAgentOverlayStatus(wc, toolName, detailLine) {
  if (!wc || wc.isDestroyed() || !_injected.has(wc)) return;
  const label = STATUS_LABELS[toolName] || 'Working\u2026';
  const detail = detailLine != null && String(detailLine).trim()
    ? String(detailLine).trim().slice(0, 140)
    : '';
  try {
    await wc.executeJavaScript(`
      (function(){
        var s=document.querySelector('#${OVERLAY_ID} .__navio_status');
        if(s) s.textContent=${JSON.stringify(label)};
        var d=document.querySelector('#${OVERLAY_ID} .__navio_detail');
        if(d) {
          d.textContent=${JSON.stringify(detail)};
          d.hidden=!d.textContent;
          d.style.display=d.textContent?'block':'none';
        }
      })()
    `);
  } catch { /* ignore */ }
}

/**
 * Brief cyan pulse at viewport (client) coordinates so the user sees where automation is acting.
 */
async function flashAgentActionRipple(wc, x, y) {
  if (!wc || wc.isDestroyed()) return;
  const xi = Math.round(Number(x));
  const yi = Math.round(Number(y));
  if (!Number.isFinite(xi) || !Number.isFinite(yi)) return;
  const sid = JSON.stringify(RIPPLE_STYLE_ID);
  const script = `
    (function(){
      var x=${xi}, y=${yi};
      var stId=${sid};
      if(!document.getElementById(stId)){
        var st=document.createElement('style');
        st.id=stId;
        st.textContent=
          '@keyframes __navioRipFlash{0%{transform:translate(-50%,-50%) scale(0.35);opacity:1}' +
          '70%{opacity:0.85}100%{transform:translate(-50%,-50%) scale(2.35);opacity:0}}';
        document.documentElement.appendChild(st);
      }
      var ring=document.createElement('div');
      ring.setAttribute('data-navio-action-flash','1');
      ring.style.cssText='position:fixed;left:'+x+'px;top:'+y+'px;z-index:2147483646;pointer-events:none;'+
        'width:52px;height:52px;border-radius:50%;border:3px solid rgba(56,189,248,0.95);'+
        'box-shadow:0 0 28px rgba(56,189,248,0.55), inset 0 0 12px rgba(255,255,255,0.12);'+
        'animation:__navioRipFlash 0.58s cubic-bezier(0.22,1,0.36,1) forwards';
      document.documentElement.appendChild(ring);
      setTimeout(function(){ try{ ring.remove(); }catch(e){} }, 620);
    })()
  `;
  try {
    await wc.executeJavaScript(script);
  } catch { /* ignore */ }
}

/**
 * Remove the overlay from a guest WebContents.
 */
async function removeAgentOverlay(wc) {
  if (!wc || wc.isDestroyed()) return;
  _injected.delete(wc);
  try {
    await wc.executeJavaScript(`
      (function(){
        var el=document.getElementById('${OVERLAY_ID}');
        if(el) el.remove();
      })()
    `);
  } catch { /* ignore */ }
  const cssKey = _cssKeys.get(wc);
  if (cssKey) {
    _cssKeys.delete(wc);
    try { await wc.removeInsertedCSS(cssKey); } catch { /* ignore */ }
  }
}

module.exports = {
  injectAgentOverlay,
  updateAgentOverlayStatus,
  removeAgentOverlay,
  flashAgentActionRipple
};
