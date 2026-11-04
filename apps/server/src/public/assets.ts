/** Inline CSS and script for the public ontology page (one self-contained file). */

export const PAGE_CSS = `
:root{
  --bg:#ffffff;--bg-soft:#f6f7f9;--bg-mast:#f3f5fa;--fg:#14181f;--muted:#5b6474;--line:#e2e5eb;--line-strong:#cdd2db;
  --accent:#3b4fd8;--accent-soft:#eceffd;--accent-fg:#2a3bb5;
  --ok:#0f7a4d;--ok-soft:#e5f5ed;--warn:#8a5a00;--warn-soft:#fff4dc;--bad:#a8323a;--bad-soft:#fdebec;--draft:#6b3fb8;--draft-soft:#f1eafc;
  --code:#f1f3f6;--shadow:0 1px 2px rgba(16,24,40,.06);
  --radius:10px;--font:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#0f1218;--bg-soft:#151a22;--bg-mast:#131824;--fg:#e7eaf0;--muted:#9aa3b2;--line:#252c38;--line-strong:#343d4c;
  --accent:#8b9bff;--accent-soft:#1d2440;--accent-fg:#aab6ff;
  --ok:#5fd19b;--ok-soft:#10291e;--warn:#f0c062;--warn-soft:#2b220e;--bad:#ff8a92;--bad-soft:#2e1316;--draft:#c3a4ff;--draft-soft:#231a36;
  --code:#1a202a;--shadow:none;color-scheme:dark;
}}
:root[data-theme="dark"]{
  --bg:#0f1218;--bg-soft:#151a22;--bg-mast:#131824;--fg:#e7eaf0;--muted:#9aa3b2;--line:#252c38;--line-strong:#343d4c;
  --accent:#8b9bff;--accent-soft:#1d2440;--accent-fg:#aab6ff;
  --ok:#5fd19b;--ok-soft:#10291e;--warn:#f0c062;--warn-soft:#2b220e;--bad:#ff8a92;--bad-soft:#2e1316;--draft:#c3a4ff;--draft-soft:#231a36;
  --code:#1a202a;--shadow:none;color-scheme:dark;
}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{scroll-padding-top:64px}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 var(--font);-webkit-font-smoothing:antialiased}
a{color:var(--accent-fg);text-decoration-thickness:1px;text-underline-offset:2px}
a:hover{text-decoration-thickness:2px}
code,pre{font-family:var(--mono);font-size:.875em}
code{background:var(--code);padding:.1em .35em;border-radius:5px;overflow-wrap:anywhere}
pre.code{background:var(--code);padding:14px 16px;border-radius:var(--radius);overflow-x:auto;line-height:1.5}
pre.code code{background:none;padding:0}
h1,h2,h3,h4,h5{line-height:1.25;margin:0 0 .5em}
h1{font-size:clamp(1.8rem,3.5vw,2.6rem);letter-spacing:-.02em}
h2{font-size:1.45rem;letter-spacing:-.01em}
h3{font-size:1.1rem;margin-top:1.4em}
h5{font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:1em 0 .3em}
p{margin:0 0 .8em}
.wrap{max-width:1180px;margin:0 auto;padding:0 24px}
.muted{color:var(--muted)}
.small{font-size:.875rem}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.skip{position:absolute;left:-999px;top:8px;background:var(--accent);color:#fff;padding:8px 12px;border-radius:6px;z-index:10}
.skip:focus{left:8px}
.masthead{background:var(--bg-mast);padding:28px 0 18px}
.tabbar{position:sticky;top:0;z-index:5;background:var(--bg-mast);border-bottom:1px solid var(--line)}
.crumbs{font-size:.875rem;color:var(--muted);margin-bottom:.6em}
.crumbs a{color:var(--muted)}
.subtitle{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:1em}
.version{font-weight:600}
.status,.level,.kind,.pill,.ucs,.req{display:inline-block;font-size:.75rem;font-weight:600;line-height:1;padding:5px 8px;border-radius:999px;white-space:nowrap;vertical-align:middle}
.status-latest{background:var(--ok-soft);color:var(--ok)}
.status-old{background:var(--warn-soft);color:var(--warn)}
.status-draft{background:var(--draft-soft);color:var(--draft)}
.level-major{background:var(--bad-soft);color:var(--bad)}
.level-minor{background:var(--accent-soft);color:var(--accent-fg)}
.level-patch{background:var(--bg-soft);color:var(--muted);border:1px solid var(--line)}
.notice{border:1px solid var(--line);background:var(--bg-soft);border-radius:var(--radius);padding:12px 14px;margin:0 0 1em}
.notice.warn{border-color:transparent;background:var(--warn-soft);color:var(--warn)}
.notice.draft{border-color:transparent;background:var(--draft-soft);color:var(--draft)}
.notice a{color:inherit;font-weight:600}
dl.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,480px),1fr));gap:2px 32px;margin:0 0 1em}
dl.meta .row{display:grid;grid-template-columns:150px 1fr;gap:12px;padding:6px 0;border-bottom:1px dashed var(--line)}
dl.meta dt{color:var(--muted);font-size:.875rem;padding-top:.1em}
dl.meta dd{margin:0;min-width:0;overflow-wrap:anywhere}
dl.meta dd ul{margin:0;padding-left:1.1em}
dl.meta dd code{background:none;padding:0}
.downloads{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0}
.chip{display:inline-block;border:1px solid var(--line-strong);background:var(--bg);border-radius:999px;padding:3px 11px;font-size:.85rem;text-decoration:none;color:var(--fg);margin:0 6px 6px 0}
.chip:hover{border-color:var(--accent);color:var(--accent-fg)}
.chip.deprecated{text-decoration:line-through;color:var(--muted)}
.tabs{display:flex;gap:4px;overflow-x:auto;scrollbar-width:none}
.tabs a{padding:10px 14px;border-bottom:3px solid transparent;color:var(--muted);text-decoration:none;font-weight:600;white-space:nowrap}
.tabs a:hover{color:var(--fg)}
.tabs a[aria-selected="true"]{color:var(--fg);border-bottom-color:var(--accent)}
.count{display:inline-block;min-width:1.5em;text-align:center;font-size:.72rem;font-weight:600;padding:1px 6px;border-radius:999px;background:var(--bg-soft);border:1px solid var(--line);color:var(--muted)}
main{padding-top:28px;padding-bottom:48px}
.js .panel[hidden]{display:none}
html:not(.js) .panel+.panel{border-top:1px solid var(--line);margin-top:32px;padding-top:32px}
.block{margin-bottom:36px}
.spec{display:grid;grid-template-columns:220px minmax(0,1fr);gap:40px}
.toc{position:sticky;top:64px;align-self:start;font-size:.9rem;max-height:calc(100vh - 80px);overflow:auto}
.toc-title{font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-size:.75rem}
.toc ol{list-style:none;margin:0;padding:0}
.toc li{padding:4px 0;display:flex;justify-content:space-between;gap:8px}
.toc a{color:var(--fg);text-decoration:none}
.toc a:hover{color:var(--accent-fg)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:8px}
.stat{border:1px solid var(--line);border-radius:var(--radius);padding:14px 16px;text-decoration:none;color:var(--fg);background:var(--bg);box-shadow:var(--shadow)}
.stat strong{display:block;font-size:1.6rem;line-height:1.1}
.stat span{color:var(--muted);font-size:.875rem}
.stat:hover{border-color:var(--accent)}
.tree ul{list-style:none;margin:0;padding-left:18px;border-left:1px solid var(--line)}
.tree>ul{padding-left:0;border-left:0}
.tree li{padding:3px 0 3px 10px;position:relative}
.tree ul ul li::before{content:"";position:absolute;left:-1px;top:15px;width:8px;border-top:1px solid var(--line)}
.filter input{width:100%;max-width:360px;padding:8px 12px;border:1px solid var(--line-strong);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit;margin-bottom:8px}
.index-group h3{font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:1em 0 .5em}
.term{border:1px solid var(--line);border-radius:var(--radius);padding:18px 20px;margin:0 0 14px;background:var(--bg);box-shadow:var(--shadow)}
.term:target,.uc:target,tr:target,.flash{outline:2px solid var(--accent);outline-offset:2px}
.term.is-deprecated{opacity:.85}
.term-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:4px}
.term-head h4{font-size:1.15rem;margin:0}
.permalink{color:var(--muted);text-decoration:none;margin-right:6px;font-weight:400}
.permalink:hover{color:var(--accent-fg)}
.kind-class{background:#fff1e0;color:#9a4d00}
.kind-objectProperty{background:#e3f2fd;color:#0b5394}
.kind-datatypeProperty{background:#e6f6ea;color:#1d6b34}
.kind-annotationProperty{background:#f1f1f4;color:#555b66}
.kind-individual{background:#f6e8fb;color:#7a2d91}
.kind-deprecated{background:var(--bad-soft);color:var(--bad)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .kind-class{background:#33230f;color:#ffbf73}:root:not([data-theme="light"]) .kind-objectProperty{background:#0f2638;color:#8cc6ff}:root:not([data-theme="light"]) .kind-datatypeProperty{background:#11291a;color:#86dba0}:root:not([data-theme="light"]) .kind-annotationProperty{background:#22252c;color:#b6bcc8}:root:not([data-theme="light"]) .kind-individual{background:#2a1631;color:#e3a6f5}}
.iri{margin:0 0 .6em;font-size:.85rem;color:var(--muted)}
.iri code{background:none;padding:0}
.definition{font-size:1.02rem;margin-bottom:.8em}
dl.facts{margin:0;border-top:1px solid var(--line)}
dl.facts .row{display:grid;grid-template-columns:150px minmax(0,1fr);gap:12px;padding:7px 0;border-bottom:1px solid var(--line)}
dl.facts .row:last-child{border-bottom:0}
dl.facts dt{color:var(--muted);font-size:.875rem}
dl.facts dd{margin:0;min-width:0;overflow-wrap:anywhere}
dl.facts ul{margin:0;padding-left:1.1em}
.ref{font-weight:500;text-decoration-color:color-mix(in srgb,currentColor 35%,transparent)}
.ref.deprecated{text-decoration:line-through}
.ref.ext code{background:none;padding:0}
.kw{font-family:var(--mono);font-size:.82em;color:var(--draft);font-weight:600}
.lit{color:var(--ok)}
.example{font-style:italic}
.sep{color:var(--muted)}
.pill{background:var(--bg-soft);color:var(--muted);border:1px solid var(--line)}
.table{width:100%;border-collapse:collapse;font-size:.95rem}
.table th,.table td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
.table th{font-size:.78rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:600}
.table tr.current td{background:var(--accent-soft)}
.prose{max-width:76ch}
.prose ul,.prose ol{padding-left:1.3em}
.lede{font-size:1.1rem;color:var(--muted);max-width:70ch}
.summary{font-weight:600}
.eyebrow{font-size:.78rem;text-transform:uppercase;letter-spacing:.07em;color:var(--accent-fg);font-weight:700;margin-bottom:.3em}
.story{border:1px solid var(--line);border-radius:var(--radius);padding:24px 28px;background:var(--bg-soft)}
.uc-ref{font-family:var(--mono);font-size:.85em;font-weight:600;background:var(--accent-soft);padding:1px 6px;border-radius:5px;text-decoration:none}
.req-met{background:var(--ok-soft);color:var(--ok)}
.req-partial{background:var(--warn-soft);color:var(--warn)}
.req-open{background:var(--bg-soft);color:var(--muted);border:1px solid var(--line)}
.uc-filters{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}
.uc-filters button{font:inherit;font-size:.875rem;border:1px solid var(--line-strong);background:var(--bg);color:var(--fg);border-radius:999px;padding:4px 12px;cursor:pointer}
.uc-filters button[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:#fff}
.uc-filters button[aria-pressed="true"] .count{background:rgba(255,255,255,.2);color:#fff;border-color:transparent}
html:not(.js) .uc-filters{display:none}
.uc{border:1px solid var(--line);border-radius:var(--radius);padding:18px 20px;margin:0 0 14px;background:var(--bg);box-shadow:var(--shadow)}
.uc[hidden]{display:none}
.uc-head{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:8px}
.uc-head h4{margin:0;font-size:1.1rem;flex:1 1 240px}
.uc-id{font-family:var(--mono);font-weight:700;color:var(--accent-fg)}
.ucs-closed{background:var(--ok-soft);color:var(--ok)}
.ucs-addressed{background:var(--accent-soft);color:var(--accent-fg)}
.ucs-open{background:var(--warn-soft);color:var(--warn)}
.ucs-parked{background:var(--bg-soft);color:var(--muted);border:1px solid var(--line)}
.ucs a{color:inherit}
.uc ul{padding-left:1.2em}
.cqs li{margin-bottom:.3em}
.uc-meta{font-size:.875rem;margin:.6em 0 0}
.foot{border-top:1px solid var(--line);padding-top:18px;padding-bottom:36px;color:var(--muted);font-size:.875rem}
.foot a{color:var(--muted)}
details summary{cursor:pointer;font-weight:600;margin-bottom:8px}
@media (max-width:860px){
  .spec{grid-template-columns:1fr;gap:0}
  .toc{position:static;top:auto;max-height:none;border:1px solid var(--line);border-radius:var(--radius);padding:12px 16px;margin-bottom:24px}
  .wrap{padding:0 16px}
  dl.meta .row,dl.facts .row{grid-template-columns:1fr;gap:2px}
  .story{padding:18px}
  .table{display:block;overflow-x:auto}
}
@media print{.tabs,.toc,.uc-filters,.filter,.filter-empty,.skip{display:none!important}.panel[hidden],.uc[hidden],.index-group[hidden]{display:block!important}[data-term][hidden]{display:inline-block!important}.term,.uc{break-inside:avoid;box-shadow:none}}
`;

/**
 * Tabs that follow the URL hash: #tab-use-cases opens a tab, and a term or use
 * case anchor (e.g. #Volunteer, #uc-123) opens the tab that contains it and
 * scrolls to it. Without JavaScript every panel is shown in order.
 */
export const PAGE_SCRIPT = `
(function(){
  var root=document.documentElement;root.classList.add('js');
  var tabs=[].slice.call(document.querySelectorAll('[role="tab"]'));
  var panels=[].slice.call(document.querySelectorAll('[role="tabpanel"]'));
  function show(id){
    tabs.forEach(function(t){var on=t.getAttribute('aria-controls')===id;t.setAttribute('aria-selected',on?'true':'false');t.tabIndex=on?0:-1;});
    panels.forEach(function(p){p.hidden=p.id!==id;});
  }
  function find(hash){
    var id=hash.replace(/^#/,'');try{id=decodeURIComponent(id);}catch(e){}
    return id?document.getElementById(id):null;
  }
  function route(scroll){
    var el=find(location.hash);
    var panel=el?(el.getAttribute('role')==='tabpanel'?el:el.closest('[role="tabpanel"]')):null;
    show(panel?panel.id:panels[0].id);
    // A use case hidden by the status filter: clear the filter so the link lands on it.
    if(el&&el.classList.contains('uc')&&el.hidden){var all=document.querySelector('[data-filter="all"]');if(all)all.click();}
    if(el&&panel&&el!==panel&&scroll!==false){el.scrollIntoView({block:'start'});}
  }
  tabs.forEach(function(t,i){
    t.addEventListener('click',function(e){
      e.preventDefault();var id=t.getAttribute('aria-controls');
      history.pushState(null,'','#'+id);show(id);
    });
    t.addEventListener('keydown',function(e){
      var d=e.key==='ArrowRight'?1:e.key==='ArrowLeft'?-1:0;if(!d)return;
      e.preventDefault();var n=tabs[(i+d+tabs.length)%tabs.length];n.focus();n.click();
    });
  });
  window.addEventListener('hashchange',function(){route();});
  window.addEventListener('popstate',function(){route(false);});
  route();

  var input=document.getElementById('term-filter');
  if(input){input.addEventListener('input',function(){
    var q=input.value.trim().toLowerCase();var any=false;
    document.querySelectorAll('[data-term]').forEach(function(c){var hit=!q||c.getAttribute('data-term').indexOf(q)>=0;c.hidden=!hit;if(hit)any=true;});
    document.querySelectorAll('.index-group').forEach(function(g){g.hidden=!g.querySelector('[data-term]:not([hidden])');});
    var empty=document.querySelector('.filter-empty');if(empty)empty.hidden=any;
  });}

  var buttons=[].slice.call(document.querySelectorAll('[data-filter]'));
  buttons.forEach(function(b){b.addEventListener('click',function(){
    var f=b.getAttribute('data-filter');
    buttons.forEach(function(x){x.setAttribute('aria-pressed',x===b?'true':'false');});
    document.querySelectorAll('.uc').forEach(function(u){u.hidden=f!=='all'&&u.getAttribute('data-group')!==f;});
  });});
})();
`;
