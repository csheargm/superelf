// The demo's small popovers, one look · 演示弹出框的统一样式 (F1-8, owner decision 2026-11-23).
// The sign-in (lib/demo-boot.mjs) and waiting-list (lib/demo-waitlist-ui.mjs) popovers sit in the
// shell's shared .cmenu-pop, whose rule flattens every button into a menu row: the send button read as
// plain text and nothing said what the box was or how to close it. ONE head (title + ✕) and ONE filled
// button style for both, injected once by lib/demo-boot.mjs as window.PADemoPop.
export const POP_TITLES = Object.freeze({ signin: '登录 · Sign in', join: '加入等候名单 · Join the waiting list' });
const CLOSE_LABEL = '关闭 · Close';

const STYLE = '.demo-pop-h{display:flex;align-items:center;gap:8px;margin:0 0 8px;font-weight:600;font-size:14px;color:var(--text)}'
  + '.demo-pop-h span{flex:1}'
  + '.cmenu-pop button.demo-pop-x{display:inline-block;width:auto;padding:2px 6px;font-size:16px;line-height:1;color:var(--muted)}'
  + '.cmenu-pop button.primary.demo-pop-go,#log button.demo-answer{display:inline-block;width:auto;text-align:center;background:var(--accent);color:#fff;border:none;border-radius:8px;padding:8px 14px;font:inherit;font-size:14px;cursor:pointer}'
  + '.cmenu-pop button.primary.demo-pop-go:disabled{opacity:.6}#log button.demo-answer{display:block;margin-top:8px}';

// head(pop, title, onClose): puts the title row with its ✕ first in the popover. go(button): the filled look.
export const POP_UI = `<style>${STYLE}</style><script>window.PADemoPop={
head:function(p,t,x){var h=document.createElement('div'),s=document.createElement('span'),c=document.createElement('button');h.className='demo-pop-h';s.textContent=t;
c.type='button';c.className='demo-pop-x';c.textContent='✕';c.setAttribute('aria-label',${JSON.stringify(CLOSE_LABEL)});c.onclick=x;h.appendChild(s);h.appendChild(c);p.insertBefore(h,p.firstChild);return h;},
go:function(b){b.classList.add('demo-pop-go');return b;},T:${JSON.stringify(POP_TITLES)}};</script>`;
