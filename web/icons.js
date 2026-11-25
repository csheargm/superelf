/* PAIcons（图标）— the ONE inline line-icon set for the shell (replaces the emoji buttons: ☰ 🔍 ⚙️ ↺ ⋯ ✕).
   24px viewBox, 1.8 stroke, currentColor, so every icon follows the text colour and both themes.
   Also picks each app tile's coloured icon from its slug/title (no per-app config needed); an app
   that matches nothing still gets a stable colour from its name, so tiles never look unfinished.
   Unit-tested by test/new-look.test.mjs. */
const PAIcons=(function(){
  const P={
    menu:'<path d="M4 7h16M4 12h16M4 17h16"/>',
    search:'<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    plus:'<path d="M12 5v14M5 12h14"/>',
    gear:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0V21a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 14.1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9 4.6V4.5a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 19.4 9h.1a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    refresh:'<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
    down:'<path d="M6 9l6 6 6-6"/>',
    back:'<path d="M15 5l-7 7 7 7"/>',
    chev:'<path d="M9 5l7 7-7 7"/>',
    up:'<path d="M12 19V5M6 11l6-6 6 6"/>',
    stop:'<rect x="7" y="7" width="10" height="10" rx="2"/>',
    more:'<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
    close:'<path d="M6 6l12 12M18 6L6 18"/>',
    chat:'<path d="M4 5h16v11H9l-5 4z"/>',
    // message actions (copy / read aloud; ask again = refresh, edit = pen). web/chat-ui.inline.html mirrors these four
    // (an app page cannot load this file); test/chat-action-icons.test.mjs pins the copies equal (R3).
    copy:'<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>',
    speaker:'<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
    // app glyphs
    book:'<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 21V5M12 7v6M9 10h6"/>',
    users:'<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0M16 4a3 3 0 0 1 0 6M21 20a5 5 0 0 0-4-5"/>',
    church:'<path d="M12 2v4M10 4h4M6 21V11l6-5 6 5v10M3 21h18M10 21v-4a2 2 0 0 1 4 0v4"/>',
    pen:'<path d="M15 4l5 5L9 20H4v-5z"/><path d="M13 6l5 5"/>',
    sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/>',
    news:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h10M7 12h10M7 16h6"/>',
    cal:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    leaf:'<path d="M5 19C5 10 10 5 20 4c-1 10-6 15-15 15z"/><path d="M5 19l8-8"/>',
    flower:'<path d="M12 21v-8"/><path d="M12 17c-3 0-5-2-5-5 3 0 5 2 5 5zM12 15c2 0 4-1.5 4-4-2 0-4 1.5-4 4z"/><circle cx="12" cy="5.5" r="2"/><circle cx="6.5" cy="4.5" r=".9"/><circle cx="17.5" cy="4" r=".9"/>',
    heart:'<path d="M12 20s-8-5-8-11a4.5 4.5 0 0 1 8-3 4.5 4.5 0 0 1 8 3c0 6-8 11-8 11z"/>',
    mic:'<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    grid:'<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
    bulb:'<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z"/>',
    flag:'<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
    drop:'<path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z"/>',
    home:'<path d="M3 11l9-7 9 7M5 10v10h14V10"/>',
    pot:'<path d="M4 10h16v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4zM2 10h20M9 6c0-1 1-1 1-2M14 6c0-1 1-1 1-2"/>',
    pulse:'<path d="M3 12h4l3-7 4 14 3-7h4"/>',
    sigma:'<path d="M17 4H6l6 8-6 8h11"/>',
    key:'<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3"/>',
    flask:'<path d="M9 3h6M10 3v6L4 19a1.5 1.5 0 0 0 1.3 2h13.4A1.5 1.5 0 0 0 20 19l-6-10V3"/>',
    chip:'<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
    check:'<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M8 12l3 3 5-6"/>',
    spark:'<path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z"/>',
  };
  const svg=(k,cls)=>`<svg class="pi${cls?' '+cls:''}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${P[k]||P.spark}</svg>`;
  // First match wins; slug and title are both searched, lower-cased. Colours are mid-tone so the
  // white glyph on the gradient keeps >= 3:1 (non-text UI) in both themes.
  const RULES=[
    [/value|价值/,'heart','#a2456e'],[/bible|圣经|scripture/,'book','#3f6b8f'],[/sunday|study|查经/,'users','#7a5aa6'],[/church|教会/,'church','#a06a3a'],
    [/journal|note|手写|笔记/,'pen','#3f7d64'],[/task|todo|待办/,'check','#d0603b'],[/digest|brief|news|简报|新闻/,'news','#2f7d8c'],
    [/calendar|日历|schedule/,'cal','#c2463c'],[/rise|morning|晨/,'sun','#c98a1c'],[/allerg|pollen|花粉/,'flower','#4f8a32'],
    [/diabet|glucose|血糖/,'drop','#c24b6a'],[/longev|health|reserve|长寿|健康/,'pulse','#2f8a6a'],[/family|家庭/,'home','#6b6fb3'],
    [/food|cook|meal|kitchen|厨房|食/,'pot','#c27a2c'],[/conf|event|会议/,'mic','#4a5bb8'],
    [/productiv|hub|效率/,'grid','#5b6470'],[/brainstorm|idea|头脑|想法/,'bulb','#b8901a'],[/club|grade|school|社团|年级/,'flag','#2e7fb8'],
    [/math|algebra|代数|数学/,'sigma','#7b4fb0'],[/rent|house|home-hunt|房/,'key','#8a6d3b'],[/research|研究/,'flask','#2f8f86'],
    [/semi|chip|半导体/,'chip','#44607a'],[/chat|对话/,'chat','#3a6fd0'],
  ];
  const SPARE=['#3a6fd0','#7a5aa6','#2f8a6a','#c2463c','#c27a2c','#2e7fb8','#a2456e','#5b6470'];
  function appIcon(a){
    const s=((a&&a.name)||'')+' '+((a&&a.title)||'');
    const k=s.toLowerCase();
    for(const [re,icon,color] of RULES) if(re.test(k)) return {icon,color};
    let h=0; for(const ch of s) h=(h*31+ch.codePointAt(0))>>>0;
    return {icon:'spark',color:SPARE[h%SPARE.length]};
  }
  function tileIcon(a){ const {icon,color}=appIcon(a); return `<span class="app-ic" style="--c:${color}">${svg(icon)}</span>`; }
  // Fills every [data-icon] in root with its icon: the static markup stays readable (data-icon="gear").
  function hydrate(root){ (root||document).querySelectorAll('[data-icon]').forEach((el)=>{ if(!el.querySelector('svg.pi')) el.insertAdjacentHTML('afterbegin',svg(el.dataset.icon)); }); }
  return {svg,appIcon,tileIcon,hydrate,names:Object.keys(P)};
})();
