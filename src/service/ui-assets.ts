/** The stylesheet, the one fixed script, the icon sprite, and the palette of /ui. Each is the same text on every page, so the page policy allows the script by one hash. */

/** Lane colors carry meaning: violet is the owner, teal the agents, green landing, red-orange stuck. docs/cloud.md records the contrast of each pair. */
export const palette = {
  light: {
    bg: '#EDEFF5', surface: '#FFFFFF', ink: '#0F1220', ink2: '#3E4560', edge: '#6F7790', hair: '#D9DDE8',
    you: '#5B2EE8', agents: '#006F86', land: '#08783C', stuck: '#C2370B', on: '#FFFFFF',
    'you-wash': '#EEEAFD', 'agents-wash': '#E0F2F6', 'land-wash': '#E0F3E7', 'stuck-wash': '#FDEAE2',
    hero: '#14183A', 'hero-edge': '#14183A', 'hero-ink': '#FFFFFF', 'hero-ink2': '#B9C0DC',
    'hero-you': '#A28BFF', 'hero-agents': '#3FC8F0', 'hero-land': '#45D98E', 'hero-stuck': '#FF9358', 'hero-on': '#0B0D14',
  },
  dark: {
    bg: '#0B0D14', surface: '#151824', ink: '#EDEFF7', ink2: '#A8B0C6', edge: '#6B7391', hair: '#262B3D',
    you: '#A28BFF', agents: '#3FC8F0', land: '#45D98E', stuck: '#FF9358', on: '#0B0D14',
    'you-wash': '#241E4D', 'agents-wash': '#0F2B38', 'land-wash': '#0E2F22', 'stuck-wash': '#3A2110',
    hero: '#1C2147', 'hero-edge': '#3A4280', 'hero-ink': '#FFFFFF', 'hero-ink2': '#B9C0DC',
    'hero-you': '#A28BFF', 'hero-agents': '#3FC8F0', 'hero-land': '#45D98E', 'hero-stuck': '#FF9358', 'hero-on': '#0B0D14',
  },
} as const;

function tokens(values: Readonly<Record<string, string>>): string {
  return Object.entries(values).map(([name, value]) => `--${name}:${value};`).join('');
}

export const styles = `
@media (prefers-reduced-motion:no-preference){
  @view-transition{navigation:auto}
  ::view-transition-group(root),::view-transition-old(root),::view-transition-new(root){animation-duration:80ms}
}
:root{
  color-scheme:light dark;
  --sans:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic","Noto Sans JP",system-ui,sans-serif;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
  --head-h:56px;--tab-h:60px;--bar-h:60px;--r:16px;--r2:12px;
  ${tokens(palette.light)}
}
@media (prefers-color-scheme:dark){:root{${tokens(palette.dark)}}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 var(--sans);font-synthesis:none;-webkit-font-smoothing:antialiased;
  padding-bottom:calc(var(--tab-h) + env(safe-area-inset-bottom) + 24px)}
body.has-bar{padding-bottom:calc(var(--tab-h) + var(--bar-h) + env(safe-area-inset-bottom) + 32px)}
a{color:inherit}
h1,h2,h3,p,ul,ol,dl,dd,figure{margin:0}
h1,h2,h3{line-height:1.2;letter-spacing:-.015em}
ul,ol{padding:0;list-style:none}
.mono{font-family:var(--mono);font-size:.875em;letter-spacing:0}
.sprite{position:absolute;width:0;height:0;overflow:hidden}
.i{width:20px;height:20px;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.i.sm{width:16px;height:16px}
:focus-visible{outline:3px solid var(--ink);outline-offset:2px}
.hero :focus-visible{outline-color:var(--hero-ink)}
.skip{position:absolute;left:8px;top:-120px;z-index:60;background:var(--ink);color:var(--bg);padding:12px 16px;border-radius:var(--r2);font-weight:700}
.skip:focus{top:8px}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}

/* a stuck row is not good news: its buttons stay neutral. Placed before the lane themes so a button with its own lane class wins. */
:where(.l-stuck) .btn{--c:var(--ink)}
/* lane themes: one hue per lane, reused by tabs, chips, rails, buttons */
.l-you{--c:var(--you);--cw:var(--you-wash);--hc:var(--hero-you)}
.l-agents{--c:var(--agents);--cw:var(--agents-wash);--hc:var(--hero-agents)}
.l-land{--c:var(--land);--cw:var(--land-wash);--hc:var(--hero-land)}
.l-stuck{--c:var(--stuck);--cw:var(--stuck-wash);--hc:var(--hero-stuck)}

/* chrome */
.foot{margin:24px 0 0;padding:0 0 8px;font-size:13px;color:var(--ink2)}
.top{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:4px;height:calc(var(--head-h) + env(safe-area-inset-top));
  padding:env(safe-area-inset-top) max(8px,env(safe-area-inset-right)) 0 max(16px,env(safe-area-inset-left));
  background:var(--surface);border-bottom:1px solid var(--hair);view-transition-name:top}
.brand{display:flex;align-items:center;gap:10px;min-height:44px;min-width:44px;padding:0 6px;text-decoration:none;font-weight:800;letter-spacing:-.02em}
.brand b{display:grid;place-items:center;width:32px;height:32px;border-radius:10px;background:var(--ink);color:var(--bg);font-size:15px}
.brand span{display:none}
.who{margin-left:auto;display:flex;align-items:center;gap:6px;font-size:13px;color:var(--ink2);white-space:nowrap}
.who b{color:var(--ink);font-weight:700}
.ibtn{flex:none;display:grid;place-items:center;width:44px;height:44px;border-radius:var(--r2);text-decoration:none;color:var(--ink)}
.ibtn.plus{background:var(--ink);color:var(--bg)}
.search-inline{display:none}
.tabs{position:fixed;left:0;right:0;bottom:0;z-index:30;display:grid;grid-template-columns:repeat(6,minmax(0,1fr));
  padding-bottom:env(safe-area-inset-bottom);background:var(--surface);border-top:1px solid var(--hair);view-transition-name:tabs}
.tabs a{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-height:var(--tab-h);padding:6px 2px;
  text-decoration:none;font-size:12px;font-weight:700;color:var(--ink2)}
.tabs a .i{color:var(--c,var(--ink));width:24px;height:24px}
.tabs a[aria-current=page]{color:var(--ink)}
.tabs a[aria-current=page]::before{content:"";position:absolute;top:0;left:22%;right:22%;height:3px;border-radius:0 0 3px 3px;background:var(--c,var(--ink))}
.tabs .n{position:absolute;top:5px;left:calc(50% + 8px);min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--c);color:var(--on);
  font-size:12px;font-weight:800;line-height:18px;text-align:center}
main{display:block;width:100%;max-width:1240px;margin:0 auto;padding:16px max(16px,env(safe-area-inset-right)) 0 max(16px,env(safe-area-inset-left))}
.page-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:8px 16px;margin:8px 0 16px}
.page-head h1{font-size:28px;font-weight:800;letter-spacing:-.03em}
.page-head p{color:var(--ink2);font-size:15px;flex-basis:100%}
.crumbs{display:flex;flex-wrap:wrap;gap:4px 12px;margin:0 0 4px;font-size:14px}
.crumbs a{display:inline-flex;align-items:center;gap:4px;min-height:44px;color:var(--ink2);text-decoration:none;font-weight:600}
.subtabs{display:flex;gap:4px;margin:0 0 16px;padding:4px;border-radius:14px;background:var(--hair);width:fit-content}
.subtabs a{display:grid;place-items:center;min-height:44px;padding:0 18px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;color:var(--ink2)}
.subtabs a[aria-current=page]{background:var(--surface);color:var(--ink)}

/* the brief */
.hero{background:var(--hero);color:var(--hero-ink);border:1px solid var(--hero-edge);border-radius:20px;padding:16px 16px 2px;margin-bottom:16px}
.eyebrow{font-size:13px;font-weight:700;color:var(--hero-ink2);letter-spacing:.02em}
.hero h1{margin:6px 0 4px;font-size:30px;font-weight:800;line-height:1.1;letter-spacing:-.03em}
.hero .sub{font-size:15px;color:var(--hero-ink2)}
.hero a:not(.btn){text-underline-offset:.18em}
.brief{margin:14px 0 0;display:grid}
.brief li{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"tag act" "txt txt";align-items:center;gap:0 12px;padding:8px 0 12px;border-top:1px solid rgba(255,255,255,.16)}
.brief p{font-size:16px;line-height:1.45;color:var(--hero-ink);overflow-wrap:anywhere}
.brief .bt{grid-area:txt}
.brief .btn-h{grid-area:act}
.tag{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}
.brief .tag{grid-area:tag;color:var(--hc)}
.tag .i{width:16px;height:16px}
.btn.btn-h{background:var(--hc);color:var(--hero-on);min-width:88px}
.brief .quiet{color:var(--hero-ink2)}

/* lanes and panels */
.today{display:grid;gap:16px}
.board{display:grid;gap:16px;align-items:start}
.filter-box{margin:0 0 12px}
.filter-box>summary{list-style:none;display:inline-flex;cursor:pointer}
.filter-box>summary::-webkit-details-marker{display:none}
.filter-box .filter{margin:12px 0 0}
.panel{background:var(--surface);border:1px solid var(--hair);border-radius:var(--r);overflow:hidden;min-width:0}
.panel-head{display:flex;align-items:center;gap:10px;min-height:56px;padding:8px 8px 8px 16px;background:var(--cw,var(--surface));border-bottom:1px solid var(--hair)}
.panel-head h2{font-size:17px;font-weight:800;color:var(--c,var(--ink))}
.lane-ico{display:grid;place-items:center;width:32px;height:32px;flex:none;border-radius:50%;background:var(--c);color:var(--on)}
.count{margin-left:2px;font-size:15px;font-weight:800;color:var(--ink)}
.panel-head .more{margin-left:auto;display:inline-flex;align-items:center;gap:2px;min-height:44px;padding:0 8px;font-size:14px;font-weight:700;text-decoration:none;color:var(--c,var(--ink))}
.panel-note{padding:12px 16px;font-size:14px;color:var(--ink2);border-top:1px solid var(--hair)}
.empty{display:flex;gap:12px;align-items:center;padding:20px 16px;color:var(--ink2);font-size:15px}
.empty .i{color:var(--c,var(--ink2));width:24px;height:24px}
.row{position:relative;padding:12px 16px 12px 24px;border-top:1px solid var(--hair);min-width:0}
.rows>.row:first-child{border-top:0}
.row::before{content:"";position:absolute;left:10px;top:14px;bottom:14px;width:4px;border-radius:2px;background:var(--c,var(--edge))}
.meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;font-size:13px;color:var(--ink2)}
.meta .mono{color:var(--ink)}
.title{display:block;padding:10px 0;margin:-6px 0 -2px;font-size:17px;line-height:1.4;font-weight:650;text-decoration:none;overflow-wrap:anywhere}
.title:hover{text-decoration:underline;text-underline-offset:.15em}
.sub-line{margin:-4px 0 8px;font-size:14px;color:var(--ink2);overflow-wrap:anywhere}
.acts{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start}
details.act{flex:1 1 100%;min-width:0}
details.act>summary{list-style:none;display:inline-flex;cursor:pointer}
details.act>summary::-webkit-details-marker{display:none}
details.act[open]>summary{background:transparent;color:var(--ink);border-color:var(--edge)}
.pane{margin-top:10px;padding:12px;border-radius:var(--r2);background:var(--cw,var(--bg));border:1px solid var(--hair)}
.rest{padding:12px 16px;font-size:14px;color:var(--ink2);border-top:1px solid var(--hair)}

/* controls */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:48px;padding:0 18px;border:2px solid transparent;border-radius:var(--r2);
  background:var(--c,var(--ink));color:var(--on);font:inherit;font-size:16px;font-weight:700;line-height:1.2;text-decoration:none;text-align:center;cursor:pointer;
  -webkit-appearance:none;appearance:none;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
.btn:hover{filter:brightness(1.08)}
.btn:active{filter:brightness(.92)}
.btn.sm{min-height:44px;padding:0 14px;font-size:15px}
.btn.ghost{background:transparent;color:var(--ink);border-color:var(--edge)}
.btn.ghost.danger{color:var(--stuck);border-color:var(--stuck)}
.btn:disabled,.btn[aria-disabled=true]{background:var(--hair);color:var(--ink2);border-color:transparent;cursor:not-allowed;filter:none}
.btn-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(88px,1fr));gap:8px}
.btn-row.col{grid-template-columns:1fr}
.field{display:grid;gap:6px;margin-bottom:12px}
.field>label,.lbl{font-size:13px;font-weight:700;color:var(--ink2)}
textarea,input[type=text],input[type=search],select{display:block;width:100%;min-height:48px;margin:0;padding:12px 14px;border:2px solid var(--edge);border-radius:var(--r2);
  background:var(--surface);color:var(--ink);font:inherit;font-size:16px;line-height:1.5}
textarea,input[type=text],input[type=search]{-webkit-appearance:none;appearance:none}
textarea{min-height:104px;resize:vertical}
textarea::placeholder,input::placeholder{color:var(--ink2);opacity:1}
textarea:focus-visible,input:focus-visible,select:focus-visible{border-color:var(--ink)}
.check{display:flex;align-items:center;gap:12px;min-height:44px;font-size:15px}
.check input{width:24px;height:24px;margin:0;accent-color:var(--c,var(--ink))}
.hint{font-size:13px;color:var(--ink2);margin:0 0 12px}
.live{margin-top:8px;padding:8px 12px;border-left:4px solid var(--edge);border-radius:8px;background:var(--surface);color:var(--ink);font-size:15px;font-weight:600;overflow-wrap:anywhere}
.live:empty{display:none}
.live[data-state=ok]{background:var(--land-wash);border-left-color:var(--land)}
.live[data-state=error]{background:var(--stuck-wash);border-left-color:var(--stuck)}
[data-row][data-done]>.meta,[data-row][data-done]>.title,[data-row][data-done]>.sub-line,[data-row][data-done]>.lease{opacity:.55}
[data-row][data-done] .btn,[data-row][data-done] .field,[data-row][data-done] .check,[data-row][data-done] .hint{display:none}
[data-row][data-done] .pane{padding:0;border:0;background:none;margin-top:0}
.seg{display:grid;grid-template-columns:repeat(auto-fit,minmax(72px,1fr));gap:6px}
.seg.s2{grid-template-columns:repeat(2,minmax(0,1fr))}
.seg.p5{grid-template-columns:repeat(5,minmax(0,1fr))}
.seg .btn{min-height:44px;padding:0 6px;font-size:15px}
.seg .btn[aria-pressed=true]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.togs{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
.tog{position:relative;display:inline-flex}
.tog input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}
.tog span{display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:0 14px;border:2px solid var(--edge);border-radius:999px;font-size:14px;font-weight:700;color:var(--ink2);background:var(--surface)}
.tog input:checked + span{background:var(--c,var(--ink));border-color:var(--c,var(--ink));color:var(--on)}
.tog input:focus-visible + span{outline:3px solid var(--ink);outline-offset:2px}

/* chips */
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chips + .chips,.chips + div .chips,.chips + p{margin-top:8px}
.chip{display:inline-flex;align-items:center;gap:4px;min-height:24px;padding:3px 9px;border-radius:999px;background:var(--hair);color:var(--ink2);
  font-size:12px;font-weight:700;line-height:1.2;white-space:nowrap}
.chip.c{background:var(--cw);color:var(--c)}
.chip .i{width:14px;height:14px}
.chip.o{background:transparent;border:1.5px solid var(--edge);color:var(--ink2)}
a.chip{text-decoration:none}
/* inline links keep a 44px hit area without changing the line box */
p a:not(.btn),.meta a,.sub-line a,.rest a,.panel-note a,.hint a,.kv a{display:inline-block;padding:14px 8px;margin:-14px -8px}
.filter{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 12px}
.filter a{display:inline-flex;align-items:center;min-height:44px;padding:0 14px;border-radius:999px;border:2px solid var(--edge);font-size:14px;font-weight:700;text-decoration:none;color:var(--ink2);background:var(--surface)}
.filter a[aria-current=page]{background:var(--ink);border-color:var(--ink);color:var(--bg)}
.filter .lbl{align-self:center;margin-right:2px}

.lease{display:grid;gap:4px;margin:2px 0 8px}
.lease p{display:flex;flex-wrap:wrap;gap:2px 8px;align-items:center;font-size:14px;color:var(--ink2)}
.lease p b{color:var(--ink)}
.lease.warn{--c:var(--stuck);--cw:var(--stuck-wash)}
.lease.gone{--c:var(--stuck);--cw:var(--stuck-wash)}
progress{display:block;width:100%;height:8px;border:0;border-radius:4px;overflow:hidden;background:var(--hair);-webkit-appearance:none;appearance:none}
progress::-webkit-progress-bar{background:var(--hair);border-radius:4px}
progress::-webkit-progress-value{background:var(--c,var(--agents));border-radius:4px}
progress::-moz-progress-bar{background:var(--c,var(--agents));border-radius:4px}
.who-dot{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:50%;background:var(--c,var(--agents));color:var(--on);font-size:12px;font-weight:800}
.who-dot.av0{background:#c2410c;color:#fff}.who-dot.av1{background:#a16207;color:#fff}.who-dot.av2{background:#4d7c0f;color:#fff}.who-dot.av3{background:#047857;color:#fff}.who-dot.av4{background:#0e7490;color:#fff}.who-dot.av5{background:#1d4ed8;color:#fff}.who-dot.av6{background:#7e22ce;color:#fff}.who-dot.av7{background:#be185d;color:#fff}
.post .meta b{font-weight:700}.post .says{margin:6px 0 4px;font-size:17px;line-height:1.45;overflow-wrap:anywhere}.post .stars{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:14px;color:var(--ink2)}
.post .stars form{display:inline}.filters{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin:0 0 16px}.filters .field{margin:0}

/* issue page */
.issue-grid{display:grid;gap:16px;margin-top:16px}
.issue-grid>*{min-width:0}
.stack{display:grid;gap:16px;align-content:start}
.card{background:var(--surface);border:1px solid var(--hair);border-radius:var(--r);padding:16px;scroll-margin:calc(var(--head-h) + 12px) 0 calc(var(--tab-h) + var(--bar-h) + 24px)}
.card>h2,.card summary h2{font-size:17px;font-weight:800;margin-bottom:12px}
.card.themed{border:2px solid var(--c);background:var(--surface)}
.card.themed>h2{color:var(--c)}
.card:target{outline:3px solid var(--ink);outline-offset:2px}
.issue-title{font-size:22px;line-height:1.3;font-weight:800;letter-spacing:-.02em;overflow-wrap:anywhere;margin:2px 0 10px}
.prose{white-space:pre-wrap;overflow-wrap:anywhere;line-break:strict;font-size:16px;line-height:1.7}
.kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 12px;font-size:15px}
.kv dt{color:var(--ink2);font-weight:600}
.kv dd{overflow-wrap:anywhere}
.since{display:flex;gap:8px;align-items:center;margin:0 0 12px;padding:8px 12px;border-radius:var(--r2);background:var(--cw);color:var(--ink);font-size:14px;font-weight:600}
.since .i{color:var(--c)}
.bar{position:fixed;left:0;right:0;z-index:25;bottom:calc(var(--tab-h) + env(safe-area-inset-bottom));display:flex;gap:8px;align-items:center;height:var(--bar-h);padding:8px 12px;
  background:var(--surface);border-top:1px solid var(--hair);box-shadow:0 -8px 20px rgba(15,18,32,.10)}
.bar>.btn,.bar form{flex:1 1 0;min-width:0}
.bar form .btn{width:100%}
.bar .btn{min-height:44px;padding:0 8px;font-size:15px}
.bar .grow{flex:1.4 1 0}
.tl{margin:0;padding:0 0 0 22px;border-left:2px solid var(--hair);margin-left:6px}
.tl>li{position:relative;padding:0 0 18px;min-width:0}
.tl>li::before{content:"";position:absolute;left:-30px;top:5px;width:14px;height:14px;border-radius:50%;background:var(--surface);border:3px solid var(--c,var(--edge))}
.tl .by{display:flex;flex-wrap:wrap;gap:2px 8px;align-items:center;font-size:13px;color:var(--ink2);margin-bottom:4px}
.tl .by b{color:var(--ink);font-size:14px}
.mini{display:grid;gap:8px}
.mini li{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;min-width:0}
.mini li>a{display:flex;align-items:center;gap:8px;min-height:44px;font-weight:600;text-decoration:none;flex:1 1 200px;min-width:0}
.mini li>a>span:last-child{min-width:0;overflow-wrap:anywhere}
.mini li>a .mono{flex:none;white-space:nowrap}
.mini li>a:hover{text-decoration:underline}
.flash{display:flex;gap:12px;align-items:flex-start;margin:0 0 16px;padding:12px 16px;border-radius:var(--r);border:2px solid var(--c);background:var(--cw);color:var(--ink);font-size:15px}
.flash .i{color:var(--c);margin-top:2px}
.flash a{font-weight:700}
.conflict{margin:0 0 16px;padding:16px;border-radius:var(--r);border:2px solid var(--stuck);background:var(--stuck-wash)}
.conflict h2{display:flex;gap:8px;align-items:center;font-size:19px;color:var(--stuck);margin-bottom:6px}
.conflict .diff{margin:12px 0;display:grid;gap:8px}
.conflict .diff>div{padding:10px 12px;border-radius:var(--r2);background:var(--surface);border:1px solid var(--hair)}
.conflict .diff .lbl{display:block;margin-bottom:4px}
.del{text-decoration:line-through;text-decoration-thickness:2px}
.role-note{margin:0 0 16px;padding:10px 14px;border-radius:var(--r2);background:var(--hair);color:var(--ink);font-size:14px}
mark{background:var(--you-wash);color:var(--ink);border-radius:3px;padding:0 2px;box-shadow:inset 0 -2px 0 var(--you)}

/* generic lists on the secondary pages */
.stat{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:8px;font-size:12px;color:var(--ink2)}
.stat b{display:block;font-size:20px;color:var(--ink);line-height:1.1}
.num{display:grid;place-items:center;width:32px;height:32px;border-radius:50%;background:var(--c);color:var(--on);font-weight:800;font-size:14px}
.row.has-num{display:grid;grid-template-columns:32px minmax(0,1fr);gap:0 12px;padding-left:16px}
.row.has-num::before{display:none}

@media (min-width:700px){
  .issue-title{font-size:26px}
  main{padding-inline:max(24px,env(safe-area-inset-left))}
  .board{grid-template-columns:repeat(2,minmax(0,1fr))}
  .brief{grid-template-columns:repeat(2,minmax(0,1fr));column-gap:28px}
  .hero{padding:24px 24px 8px}
  .hero h1{font-size:36px}
}
@media (min-width:1000px){
  body,body.has-bar{padding-bottom:48px}
  .top{--head-h:64px;gap:8px;padding-inline:max(24px,env(safe-area-inset-left))}
  .brand span{display:inline}
  .tabs{position:static;display:flex;gap:2px;margin-left:16px;padding:0;background:none;border:0;view-transition-name:none}
  .tabs a{flex-direction:row;min-height:44px;padding:0 14px;gap:8px;border-radius:var(--r2);font-size:15px}
  .tabs a .i{width:20px;height:20px}
  .tabs a[aria-current=page]{background:var(--cw,var(--hair))}
  .tabs a[aria-current=page]::before{display:none}
  .tabs .n{position:static;margin-left:2px}
  .who{margin-left:auto}
  main{padding-top:24px}
  .issue-grid{grid-template-columns:minmax(0,1fr) 340px;align-items:start}
  .bar{position:sticky;top:calc(var(--head-h) + 8px);bottom:auto;left:auto;right:auto;margin:0 0 16px;height:auto;padding:8px;border:1px solid var(--hair);border-radius:var(--r);box-shadow:none}
  .card{scroll-margin:calc(var(--head-h) + 84px) 0 24px}
}
@media (min-width:1100px){
  .search-inline{display:block;width:240px;margin-left:8px}
  .search-inline input{min-height:44px;padding:8px 14px;border-radius:999px}
  .ibtn.s{display:none}
  main{padding-inline:32px}
  .today{grid-template-columns:372px minmax(0,1fr);align-items:start}
  .today .hero{position:sticky;top:88px;margin-bottom:0}
  .brief{grid-template-columns:minmax(0,1fr)}
  .page-head h1{font-size:32px}
  .split{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:16px;align-items:start}
}
@media (min-width:1100px){.hero h1{font-size:32px}}
/* additions for the Worker: armed two-tap buttons, the push command, quoted notes, the closing lines */
.btn[data-armed]{background:var(--stuck);border-color:var(--stuck);color:var(--on)}
.cmd{margin:8px 0 0;padding:12px 14px;border-radius:var(--r2);background:var(--hair);color:var(--ink);font:14px/1.5 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere}
.quote{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin:0 0 8px;font-size:14px;color:var(--ink2);overflow-wrap:anywhere}
.quote b{color:var(--ink);font-weight:700}
.landed .check{align-items:flex-start;padding:10px 0;border-top:1px solid var(--hair)}
.landed .check:first-child{border-top:0}
.landed .check input{margin-top:2px}
.result{display:grid;gap:4px;margin:8px 0 0;font-size:15px}
.closing{margin-top:16px}
@media (min-width:1100px) and (max-width:1299px){.brand span{display:none}.tabs a{padding:0 10px}}
`;

/**
 * The only script on any page. It sends a form[data-live] with fetch and shows the server's sentence in the form's status line.
 * A 409 answer submits the form natively, so the server renders the conflict page and typed text never goes into a URL.
 * A button with data-confirm needs a second tap within four seconds. Every form also works without this script.
 */
export const pageScript = `(()=>{
const disarm=b=>{if(b.dataset.armed){b.innerHTML=b.dataset.armed;delete b.dataset.armed}};
addEventListener('click',e=>{
  const b=e.target.closest&&e.target.closest('button[data-confirm]');
  if(!b||b.dataset.armed)return;
  e.preventDefault();
  b.dataset.armed=b.innerHTML;b.textContent=b.dataset.confirm;
  setTimeout(()=>disarm(b),4000);
});
addEventListener('submit',async e=>{
  const f=e.target;
  if(!f.matches||!f.matches('form[data-live]')||f.dataset.native||f.dataset.busy)return;
  e.preventDefault();
  const b=e.submitter,out=f.querySelector('[role=status]'),was=b&&(b.dataset.armed||b.innerHTML);
  const say=(t,s)=>{if(out){out.textContent=t;out.dataset.state=s}};
  f.dataset.busy='1';
  if(out){out.textContent='';delete out.dataset.state}
  if(b){delete b.dataset.armed;b.disabled=true;b.textContent='Sending\u2026'}
  try{
    const res=await fetch(f.action,{method:'POST',body:new URLSearchParams(new FormData(f,b)),headers:{accept:'application/json'},credentials:'same-origin',redirect:'manual'});
    if(res.type==='opaqueredirect'){say('Your sign-in has expired. Reload the page. Your text is kept.','error');return}
    if(res.status===409){delete f.dataset.busy;f.dataset.native='1';if(b){b.disabled=false;b.innerHTML=was}f.requestSubmit(b);return}
    const r=await res.json();
    const ok=res.ok&&r.ok===true;
    say(r.message||(r.error&&r.error.message)||'The server answered '+res.status+'. Nothing changed.',ok?'ok':'error');
    if(ok){const row=f.closest('[data-row]');if(row)row.setAttribute('data-done','');if(f.dataset.clear!=='no')f.reset()}
  }catch(_){say('Could not reach the server. Reload the page. Your text is kept.','error')}
  finally{delete f.dataset.busy;if(b&&!f.dataset.native){b.disabled=false;b.innerHTML=was}}
});
})();`;

// A JSON block, not a program: the page policy allows it by hash, and it prefetches only /ui links.
export const speculationRules = '{"prefetch":[{"source":"document","where":{"or":[{"href_matches":"/ui"},{"href_matches":"/ui/*"}]},"eagerness":"moderate","referrer_policy":"no-referrer"}]}';

// A data: URI needs no request, and img-src data: allows it.
export const faviconHref = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%235B2EE8'/%3E"
  + "%3Cpath d='M10 23V9h6.5a4.5 4.5 0 010 9H10' fill='none' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E";

const icons: Record<string, string> = {
  today: '<rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  you: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>',
  agents: '<rect x="5" y="9" width="14" height="11" rx="3"/><circle cx="12" cy="4.5" r="1.5"/><path d="M12 6v3M9.5 14h.01M14.5 14h.01"/>',
  land: '<circle cx="6" cy="5.5" r="2.5"/><circle cx="6" cy="18.5" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M6 8v8M6 8c0 3.2 3.8 4 9.5 4"/>',
  stuck: '<circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/>',
  projects: '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
  send: '<path d="M21 3L10 14"/><path d="M21 3l-6.5 18-4-8.5L2 8.5z"/>',
  warn: '<path d="M12 4l9.5 16.5h-19z"/><path d="M12 10v4.5M12 17.5h.01"/>',
  link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
  comment: '<path d="M21 12a8 8 0 01-11.6 7.1L4 20l1-4.6A8 8 0 1121 12z"/>',
  edit: '<path d="M4 20l1-4L16.5 4.5a2 2 0 013 3L8 19z"/>',
  undo: '<path d="M4 9h10a5 5 0 010 10H8"/><path d="M8 5L4 9l4 4"/>',
  dots: '<path d="M5 12h.01M12 12h.01M19 12h.01"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
};
export type IconName = keyof typeof icons;

export const sprite = '<svg class="sprite" aria-hidden="true" focusable="false">'
  + Object.entries(icons).map(([name, path]) => `<symbol id="i-${name}" viewBox="0 0 24 24">${path}</symbol>`).join('') + '</svg>';
