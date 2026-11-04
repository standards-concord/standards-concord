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
.card{border:1px solid var(--line);border-radius:var(--radius);background:var(--bg);box-shadow:var(--shadow)}
.browse{display:grid;grid-template-columns:300px minmax(0,1fr);gap:24px;align-items:start}
.browse-nav{position:sticky;top:64px;max-height:calc(100vh - 84px);overflow:auto;padding:12px;font-size:.9rem}
.search input{width:100%;padding:8px 12px;border:1px solid var(--line-strong);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit;margin-bottom:8px}
.nav-title,.nav-group>summary{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:14px 0 4px}
.nav-group>summary{list-style:none;cursor:pointer}
.nav-group>summary::-webkit-details-marker{display:none}
.nav-group>summary::before{content:"▸";display:inline-block;width:1em;transition:transform .15s}
.nav-group[open]>summary::before{transform:rotate(90deg)}
.browse-nav ul{list-style:none;margin:0;padding:0}
.ctree ul ul{padding-left:14px}
.node{display:flex;align-items:center;gap:4px;border-radius:6px}
.ctree summary{cursor:pointer;list-style:none;font-weight:400;margin:0}
.nav-group>summary{margin-bottom:4px}
.js .browse .term:target{outline:none}
.ctree summary::-webkit-details-marker{display:none}
.ctree summary::before{content:"▸";color:var(--muted);font-size:.75rem;width:14px;flex:none;text-align:center;transition:transform .15s}
.ctree details[open]>summary::before{transform:rotate(90deg)}
.node.leaf::before{content:"•";color:var(--muted);opacity:.5;width:14px;flex:none;text-align:center}
.node .n{font-size:.65rem;color:var(--muted);margin-left:auto;padding-right:6px}
.nav-item{display:block;flex:1;min-width:0;padding:3px 8px;border-radius:6px;color:var(--fg);text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nav-item:hover{background:var(--bg-soft)}
.nav-item[aria-current="true"]{background:var(--accent-soft);color:var(--accent-fg);font-weight:600}
.nav-item.deprecated{text-decoration:line-through;color:var(--muted)}
.nav-overview{font-weight:600}
.browse-main{min-width:0}
.overview{padding:20px 22px;margin-bottom:16px}
.overview .pick{margin:12px 0 4px}
.namespaces{margin-top:12px}
.group-title{font-size:1rem;color:var(--muted);margin:24px 0 10px}
.js .term-group,.js .browse.focused .overview{display:none}
.js .term-group.is-open{display:block}
.js .browse.has-selection .term:not(.is-selected),.js .browse.has-selection .group-title{display:none}
.btn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:.875rem;font-weight:500;line-height:1.2;padding:7px 12px;border-radius:8px;border:1px solid var(--line-strong);background:var(--bg);color:var(--fg);text-decoration:none;cursor:pointer;white-space:nowrap}
.btn:hover{border-color:var(--accent);color:var(--accent-fg)}
.btn-primary{background:var(--accent);border-color:var(--accent);color:#fff}
.btn-primary:hover{color:#fff;filter:brightness(1.08)}
.btn-ghost{border-color:transparent;background:transparent;color:var(--muted)}
.btn-ghost:hover{background:var(--bg-soft);border-color:transparent}
.btn-icon{padding:4px 6px}
html:not(.js) .copy{display:none}
.copy.copied{color:var(--ok)}
.warn-text{color:var(--warn)}
.comment{font-size:.92rem}
.report-choices{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:16px;margin:12px 0 20px}
.choice{border:1px solid var(--line);border-radius:var(--radius);padding:16px 18px;background:var(--bg-soft)}
.choice h3{margin-top:0}
.field{display:block;margin-bottom:12px}
.field>span{display:block;font-size:.875rem;font-weight:600;margin-bottom:4px}
.field input,.field textarea{width:100%;padding:8px 10px;border:1px solid var(--line-strong);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
.report-dialog{border:1px solid var(--line);border-radius:14px;padding:20px 22px;max-width:760px;width:calc(100% - 32px);background:var(--bg);color:var(--fg);box-shadow:0 20px 50px rgba(0,0,0,.25)}
.report-dialog::backdrop{background:rgba(15,18,24,.45)}
.dialog-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.dialog-head h2{font-size:1.15rem;margin:0}
.report-page{padding-top:32px;max-width:860px}
.report-term{margin:16px 0}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:8px}
.stat{border:1px solid var(--line);border-radius:var(--radius);padding:14px 16px;text-decoration:none;color:var(--fg);background:var(--bg);box-shadow:var(--shadow)}
.stat strong{display:block;font-size:1.6rem;line-height:1.1}
.stat span{color:var(--muted);font-size:.875rem}
.stat:hover{border-color:var(--accent)}
.term{border:1px solid var(--line);border-radius:var(--radius);padding:20px 22px;margin:0 0 14px;background:var(--bg);box-shadow:var(--shadow)}
.term:target,.uc:target,tr:target,.flash{outline:2px solid var(--accent);outline-offset:2px}
.term.is-deprecated{opacity:.85}
.term-head{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:8px 12px;margin-bottom:2px}
.term-title{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}
.term-head h3{font-size:1.15rem;margin:0}
.permalink{color:var(--muted);text-decoration:none;margin-right:6px;font-weight:400}
.permalink:hover{color:var(--accent-fg)}
.kind-class{background:#fff1e0;color:#9a4d00}
.kind-objectProperty{background:#e3f2fd;color:#0b5394}
.kind-datatypeProperty{background:#e6f6ea;color:#1d6b34}
.kind-annotationProperty{background:#f1f1f4;color:#555b66}
.kind-individual{background:#f6e8fb;color:#7a2d91}
.kind-deprecated{background:var(--bad-soft);color:var(--bad)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .kind-class{background:#33230f;color:#ffbf73}:root:not([data-theme="light"]) .kind-objectProperty{background:#0f2638;color:#8cc6ff}:root:not([data-theme="light"]) .kind-datatypeProperty{background:#11291a;color:#86dba0}:root:not([data-theme="light"]) .kind-annotationProperty{background:#22252c;color:#b6bcc8}:root:not([data-theme="light"]) .kind-individual{background:#2a1631;color:#e3a6f5}}
.iri{display:flex;align-items:center;gap:4px;margin:0 0 .6em;font-size:.85rem;color:var(--muted)}
.iri code{background:none;padding:0}
.definition{font-size:1.02rem;margin-bottom:.8em}
dl.facts{margin:0;border-top:1px solid var(--line)}
dl.facts .row{display:grid;grid-template-columns:160px minmax(0,1fr);gap:16px;padding:9px 0;border-bottom:1px solid var(--line)}
dl.facts .row:last-child{border-bottom:0}
dl.facts dt{color:var(--muted);font-size:.8rem;font-weight:500}
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
  .browse{grid-template-columns:1fr;gap:16px}
  .browse-nav{position:static;max-height:50vh}
  .wrap{padding:0 16px}
  dl.meta .row,dl.facts .row{grid-template-columns:1fr;gap:2px}
  .story{padding:18px}
  .table{display:block;overflow-x:auto}
}
@media print{.tabs,.browse-nav,.uc-filters,.filter-empty,.skip,.report-link,.copy,.report-dialog,.pick{display:none!important}.browse{display:block}.panel[hidden],.uc[hidden],.term-group,.overview,.term{display:block!important}.group-title{display:block!important}.term,.uc{break-inside:avoid;box-shadow:none}}
`;

/**
 * Tabs that follow the URL hash: #tab-use-cases opens a tab, and a term or use
 * case anchor (e.g. #Volunteer, #uc-123) opens the tab that contains it. On
 * the Specification tab a term anchor shows that term alone, as in the app's
 * Browse view, with the tree and search on the left; the overview shows when
 * no term is picked. Without JavaScript (and in print) everything is shown in
 * order.
 */
export const PAGE_SCRIPT = `
(function(){
  var root=document.documentElement;root.classList.add('js');
  var tabs=[].slice.call(document.querySelectorAll('[role="tab"]'));
  var panels=[].slice.call(document.querySelectorAll('[role="tabpanel"]'));
  var browse=document.querySelector('.browse');
  function show(id){
    tabs.forEach(function(t){var on=t.getAttribute('aria-controls')===id;t.setAttribute('aria-selected',on?'true':'false');t.tabIndex=on?0:-1;});
    panels.forEach(function(p){p.hidden=p.id!==id;});
  }
  function find(hash){
    // As the browser does: the fragment as written first, then percent-decoded.
    var id=hash.replace(/^#/,'');if(!id)return null;
    var el=document.getElementById(id);if(el)return el;
    try{return document.getElementById(decodeURIComponent(id));}catch(e){return null;}
  }
  // Browse: which term (or group of terms) the Specification tab shows.
  function focus(el){
    if(!browse)return;
    var term=el&&el.classList.contains('term')&&browse.contains(el)?el:null;
    var group=term?term.closest('.term-group'):(el&&el.classList.contains('term-group')?el:null);
    browse.classList.toggle('has-selection',!!term);
    browse.classList.toggle('focused',!!group);
    browse.querySelectorAll('.term.is-selected').forEach(function(t){t.classList.remove('is-selected');});
    browse.querySelectorAll('.term-group.is-open').forEach(function(g){g.classList.remove('is-open');});
    if(term)term.classList.add('is-selected');
    if(group)group.classList.add('is-open');
    var href=term?'#'+term.id:group?null:'#'+(browse.querySelector('.overview')||{}).id;
    browse.querySelectorAll('.nav-item').forEach(function(a){
      var h=a.getAttribute('href');var on=false;
      if(href){try{on=h===href||decodeURIComponent(h)===href;}catch(e){on=h===href;}}
      if(on){a.setAttribute('aria-current','true');var d=a.closest('details');while(d){d.open=true;d=d.parentElement&&d.parentElement.closest('details');}
        var nav=browse.querySelector('.browse-nav');if(nav&&nav.scrollHeight>nav.clientHeight){var r=a.getBoundingClientRect(),n=nav.getBoundingClientRect();if(r.top<n.top||r.bottom>n.bottom)nav.scrollTop+=r.top-n.top-n.height/3;}}
      else a.removeAttribute('aria-current');
    });
  }
  function route(scroll){
    var el=find(location.hash);
    var panel=el?(el.getAttribute('role')==='tabpanel'?el:el.closest('[role="tabpanel"]')):null;
    show(panel?panel.id:panels[0].id);
    focus(el);
    // A use case hidden by the status filter: clear the filter so the link lands on it.
    if(el&&el.classList.contains('uc')&&el.hidden){var all=document.querySelector('[data-filter="all"]');if(all)all.click();}
    if(el&&panel&&el!==panel&&scroll!==false){
      // Beside a sticky term list the card is already at the top; on narrow screens the list comes first.
      var nav=browse&&browse.querySelector('.browse-nav');
      var beside=nav&&browse.contains(el)&&getComputedStyle(nav).position==='sticky';
      if(beside){if(browse.getBoundingClientRect().top<0)browse.scrollIntoView({block:'start'});}else el.scrollIntoView({block:'start'});
    }
  }
  tabs.forEach(function(t,i){
    t.addEventListener('click',function(e){
      e.preventDefault();var id=t.getAttribute('aria-controls');
      history.pushState(null,'','#'+id);show(id);focus(null);
    });
    t.addEventListener('keydown',function(e){
      var d=e.key==='ArrowRight'?1:e.key==='ArrowLeft'?-1:0;if(!d)return;
      e.preventDefault();var n=tabs[(i+d+tabs.length)%tabs.length];n.focus();n.click();
    });
  });
  window.addEventListener('hashchange',function(){route();});
  window.addEventListener('popstate',function(){route(false);});
  route();

  // Search: names, local names, alternative labels and definitions.
  var input=document.querySelector('input.term-filter');
  var searchStatus=document.querySelector('[data-search-status]');var searchTimer;
  if(input){input.closest('label').hidden=false;input.addEventListener('input',function(){
    var q=input.value.trim().toLowerCase();var any=false;var n=0;
    var items=[].slice.call(document.querySelectorAll('.browse-nav [data-term]')).reverse();
    items.forEach(function(li){
      var hit=!q||li.getAttribute('data-term').indexOf(q)>=0;
      var kid=!!li.querySelector('[data-term]:not([hidden])');
      li.hidden=!(hit||kid);if(q&&hit)n++;
      var d=li.querySelector(':scope > details');if(d&&q&&kid)d.open=true;
      if(!li.hidden&&q)any=true;
    });
    document.querySelectorAll('.nav-group').forEach(function(g){g.hidden=!!q&&!g.querySelector('[data-term]:not([hidden])');if(q&&!g.hidden)g.open=true;});
    var title=document.querySelector('.nav-title');if(title)title.hidden=!!q&&!document.querySelector('.ctree [data-term]:not([hidden])');
    var empty=document.querySelector('.filter-empty');if(empty)empty.hidden=!q||any;
    // Tell screen readers how many terms match, once typing pauses.
    clearTimeout(searchTimer);searchTimer=setTimeout(function(){
      if(!searchStatus)return;
      searchStatus.textContent=q?(n?n+(n===1?' term matches':' terms match'):'No terms match'):'';
    },400);
  });}

  // Copy a term's IRI.
  document.querySelectorAll('[data-copy]').forEach(function(b){b.addEventListener('click',function(){
    var done=function(){b.classList.add('copied');b.setAttribute('aria-label','Copied');setTimeout(function(){b.classList.remove('copied');b.setAttribute('aria-label','Copy IRI');},1500);};
    if(navigator.clipboard)navigator.clipboard.writeText(b.getAttribute('data-copy')).then(done,function(){});
  });});

  // Report a problem: a dialog on this site, the report page anywhere else (e.g. a copy on GitHub).
  var dialog=document.querySelector('.report-dialog');
  if(dialog&&dialog.showModal){
    var form=dialog.querySelector('.report-form');var alertBox=form.querySelector('[role="alert"]');
    var body=dialog.querySelector('[data-report-body]');var done=dialog.querySelector('[data-report-done]');
    var sending=false;
    var close=function(){dialog.close();};
    dialog.querySelectorAll('[data-close]').forEach(function(b){b.addEventListener('click',close);});
    dialog.addEventListener('click',function(e){if(e.target===dialog)close();});
    var desc=form.elements.description;
    var fail=function(msg,field){
      alertBox.textContent=msg;alertBox.hidden=false;
      if(field==='description'){desc.setAttribute('aria-invalid','true');desc.setAttribute('aria-describedby',alertBox.id);desc.focus();}
    };
    var clearError=function(){alertBox.hidden=true;desc.removeAttribute('aria-invalid');desc.removeAttribute('aria-describedby');};
    var fresh=function(){
      form.elements.token.value='';
      var q='?term='+encodeURIComponent(form.elements.term.value)+'&version='+encodeURIComponent(form.elements.version.value);
      return fetch(form.action+'/token'+q,{credentials:'same-origin',cache:'no-store'}).then(function(r){return r.json().catch(function(){return {};}).then(function(j){return {ok:r.ok,j:j};});})
        .then(function(res){if(res.ok&&res.j.token)form.elements.token.value=res.j.token;else if(res.j.error)fail(res.j.error);}).catch(function(){});
    };
    document.querySelectorAll('[data-report]').forEach(function(a){a.addEventListener('click',function(e){
      var action;try{action=new URL(form.action,location.href);}catch(err){return;}
      if(action.origin!==location.origin)return;
      e.preventDefault();
      dialog.querySelector('[data-report-name]').textContent=a.getAttribute('data-term-name');
      form.elements.term.value=a.getAttribute('data-term-iri');
      var member=dialog.querySelector('[data-member-report]');if(member)member.href=a.getAttribute('data-member-href');
      form.elements.title.value='';form.elements.description.value='';
      clearError();body.hidden=false;done.hidden=true;
      fresh();
      dialog.showModal();
    });});
    form.addEventListener('submit',function(e){
      e.preventDefault();if(sending)return;
      var data={};['term','version','token','website','title','description'].forEach(function(k){data[k]=form.elements[k]?form.elements[k].value:'';});
      sending=true;var button=form.querySelector('button[type="submit"]');button.disabled=true;
      fetch(form.action,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(data)})
        .then(function(r){return r.json().catch(function(){return {};}).then(function(j){return {ok:r.ok,j:j};});})
        .then(function(res){
          if(res.ok){
            dialog.querySelector('[data-report-ref]').textContent=res.j.reference||'';
            body.hidden=true;done.hidden=false;
            // The form that had focus is gone: move to the confirmation, which screen readers announce.
            dialog.querySelector('[data-report-done-title]').focus();
          }else{
            clearError();fail(res.j.error||'Something went wrong. Please try again.',res.j.field);
            // Each form token is good for one try; the reply carries the next.
            if(res.j.token)form.elements.token.value=res.j.token;else fresh();
          }
        })
        .catch(function(){fail('Could not send the report. Check your connection and try again.');})
        .then(function(){sending=false;button.disabled=false;});
    });
  }

  var buttons=[].slice.call(document.querySelectorAll('[data-filter]'));
  buttons.forEach(function(b){b.addEventListener('click',function(){
    var f=b.getAttribute('data-filter');
    buttons.forEach(function(x){x.setAttribute('aria-pressed',x===b?'true':'false');});
    document.querySelectorAll('.uc').forEach(function(u){u.hidden=f!=='all'&&u.getAttribute('data-group')!==f;});
  });});
})();
`;
