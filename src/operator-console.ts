export function operatorConsoleHtml(viewerPort: number): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Headless Codex · API Console</title>
  <link rel="icon" href="/assets/headless-codex-logo.png?v=1" type="image/png">
  <style>
    @font-face{font-family:Geist;src:url('/assets/geist-sans.woff2')}@font-face{font-family:Geist Mono;src:url('/assets/geist-mono.woff2')}
    :root{color-scheme:dark;font-family:Geist,system-ui,sans-serif;background:#080808;color:#ededed;--line:#292929;--muted:#999;--panel:#0d0d0d;--control:#151515;--blue:#58a6ff;--green:#56d68b}
    *{box-sizing:border-box}body{margin:0;height:100vh;overflow:hidden}button,input,textarea{font:inherit}.shell{display:grid;grid-template-columns:minmax(390px,43%) minmax(0,57%);height:100vh}.api{min-width:0;display:flex;flex-direction:column;border-right:1px solid var(--line);background:#090909}.bar{height:58px;flex:none;display:flex;align-items:center;gap:11px;padding:0 16px;border-bottom:1px solid var(--line);background:#0b0b0b}.mark{width:23px;height:23px}.brand{font-weight:650;letter-spacing:-.02em}.label{color:var(--muted);font-size:12px}.spacer{flex:1}.status{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:12px}.status:before{content:'';width:7px;height:7px;border-radius:50%;background:#777}.status.ready:before{background:var(--green)}input,textarea{width:100%;color:#eee;background:var(--control);border:1px solid #444;border-radius:6px;padding:9px 10px;font-family:Geist Mono,monospace;font-size:12px}button,.link{border:1px solid #444;border-radius:6px;padding:8px 11px;color:#eee;background:#181818;cursor:pointer;text-decoration:none;font-size:12px;white-space:nowrap}button:hover,.link:hover{background:#222;border-color:#666}.primary{background:#ededed;color:#050505;border-color:#ededed}.primary:hover{background:#fff}.body{min-height:0;display:grid;grid-template-columns:210px minmax(0,1fr);flex:1}.routes{overflow:auto;border-right:1px solid var(--line);padding:9px}.route-row{display:grid;grid-template-columns:minmax(0,1fr) 26px;align-items:center;border-radius:6px}.route-row.pinned{background:#101d17}.route{display:grid;grid-template-columns:40px 1fr;gap:7px;width:100%;padding:8px 6px;border:0;border-radius:5px;background:transparent;text-align:left}.route:hover,.route.selected{background:#191919}.route-row.pinned .route:hover,.route-row.pinned .route.selected{background:#17291f}.pin-toggle{width:24px;height:24px;padding:0;border:0;background:transparent;color:#666;font-size:13px}.pin-toggle:hover,.pin-toggle:focus-visible{background:#242424;color:#ddd}.route-row.pinned .pin-toggle{color:var(--green)}.method{font-family:Geist Mono,monospace;font-size:10px;font-weight:700;color:var(--blue)}.method.post{color:var(--green)}.path{min-width:0;overflow:hidden;text-overflow:ellipsis;color:#ccc;font-family:Geist Mono,monospace;font-size:11px;white-space:nowrap}.workspace{overflow:auto;padding:20px}.eyebrow{color:var(--muted);font:11px Geist Mono,monospace;text-transform:uppercase}.workspace h1{margin:7px 0 5px;font-size:20px;letter-spacing:-.03em}.summary{margin:0 0 20px;color:var(--muted);font-size:13px;line-height:1.5}.request-line{display:flex;align-items:center;gap:9px;padding:10px 12px;border:1px solid var(--line);border-radius:7px;background:var(--panel);font:12px Geist Mono,monospace;overflow-wrap:anywhere}.field{display:grid;gap:7px;margin-top:14px}.field label{color:#bbb;font-size:12px}.actions{display:flex;gap:8px;margin-top:14px}.response{margin-top:18px;border-top:1px solid var(--line);padding-top:17px}.response-head{display:flex;justify-content:space-between;align-items:center}.code{max-height:330px;overflow:auto;margin:10px 0 0;padding:13px;border:1px solid var(--line);border-radius:7px;background:#050505;color:#cfcfcf;font:11px/1.55 Geist Mono,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.desktop{min-width:0;display:flex;flex-direction:column;background:#111}.desktop .bar{justify-content:space-between}.desktop iframe{width:100%;height:calc(100vh - 58px);border:0;background:#111}.empty{padding:24px;color:var(--muted);font-size:13px}.mobile-switch{display:none}
    @media(max-width:820px){body{overflow:auto}.shell{display:block;height:auto}.api,.desktop{min-height:100vh;border:0}.desktop{display:none}body.show-desktop .api{display:none}body.show-desktop .desktop{display:flex}.body{grid-template-columns:145px minmax(0,1fr)}.mobile-switch{display:inline-flex}}
  </style>
</head>
<body>
<main class="shell">
  <section class="api">
    <header class="bar"><img class="mark" src="/assets/headless-codex-logo.png?v=1"><span class="brand">Headless Codex</span><span class="label">API</span><span class="spacer"></span><span id="api-status" class="status">Loading</span><button class="mobile-switch" data-pane="desktop">Desktop</button></header>
    <div class="body"><nav id="routes" class="routes" aria-label="API endpoints"></nav><section id="workspace" class="workspace"><div class="empty">Loading the OpenAPI contract…</div></section></div>
  </section>
  <section class="desktop">
    <header class="bar"><div><span class="brand">Codex Desktop</span> <span class="label">live worker</span></div><div><button id="reconnect-viewer">Reconnect</button> <button class="mobile-switch" data-pane="api">API</button></div></header>
    <iframe id="viewer" title="Headless Codex desktop" allow="clipboard-read; clipboard-write" referrerpolicy="no-referrer"></iframe>
  </section>
</main>
<script>
  const workspace = document.getElementById('workspace');
  const routes = document.getElementById('routes');
  const status = document.getElementById('api-status');
  let schema, selected, apiEntries = [];
  const viewerUrl = () => location.protocol+'//'+location.hostname+':${viewerPort}/vnc.html?autoconnect=true&resize=scale&reconnect=true';
  const connectViewer = () => { document.getElementById('viewer').src = viewerUrl(); };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const pinStorageKey = 'headless-codex-pinned-routes';
  const defaultPinnedRoutes = ['post /v1/desktop/turns', 'post /v1/auth/device'];
  let pinnedRoutes = (() => { try { const saved=localStorage.getItem(pinStorageKey); return saved===null ? [...defaultPinnedRoutes] : JSON.parse(saved); } catch { return [...defaultPinnedRoutes]; } })();
  const routeKey = entry => entry.method+' '+entry.path;
  const entries = document => Object.entries(document.paths || {}).flatMap(([path, operations]) => Object.entries(operations).filter(([method]) => ['get','post','put','patch','delete'].includes(method)).map(([method, operation]) => ({path,method,operation}))).sort((left,right) => {
    const leftPin = pinnedRoutes.indexOf(left.method+' '+left.path);
    const rightPin = pinnedRoutes.indexOf(right.method+' '+right.path);
    if (leftPin === -1 && rightPin === -1) return 0;
    if (leftPin === -1) return 1;
    if (rightPin === -1) return -1;
    return leftPin-rightPin;
  });
  function renderRoutes() {
    apiEntries = entries(schema); routes.innerHTML='';
    apiEntries.forEach(entry => {
      const key=routeKey(entry); const pinned=pinnedRoutes.includes(key);
      const row=document.createElement('div'); row.className='route-row'+(pinned?' pinned':'');
      const button=document.createElement('button'); button.className='route'; button.dataset.key=entry.method+entry.path;
      button.innerHTML='<span class="method '+entry.method+'">'+entry.method.toUpperCase()+'</span><span class="path">'+esc(entry.path)+'</span>'; button.onclick=()=>render(entry);
      const pin=document.createElement('button'); pin.className='pin-toggle'; pin.textContent=pinned?'★':'☆'; pin.title=pinned?'Remove from pinned':'Pin to top'; pin.setAttribute('aria-label',(pinned?'Unpin ':'Pin ')+entry.method.toUpperCase()+' '+entry.path);
      pin.onclick=()=>{ pinnedRoutes=pinned ? pinnedRoutes.filter(candidate=>candidate!==key) : [...pinnedRoutes,key]; localStorage.setItem(pinStorageKey,JSON.stringify(pinnedRoutes)); renderRoutes(); };
      row.append(button,pin); routes.append(row);
    });
    if(selected) document.querySelectorAll('.route').forEach(node=>node.classList.toggle('selected',node.dataset.key===selected.method+selected.path));
  }
  function exampleFor(spec) {
    if (!spec) return {};
    if (spec.example !== undefined) return spec.example;
    const target = spec.schema || spec;
    if (target.example !== undefined) return target.example;
    if (target.type === 'object' || target.properties) return Object.fromEntries(Object.entries(target.properties || {}).map(([key,value]) => [key, exampleFor(value)]));
    if (target.type === 'array') return [exampleFor(target.items)];
    if (target.default !== undefined) return target.default;
    if (target.enum) return target.enum[0];
    if (target.type === 'boolean') return false;
    if (target.type === 'number' || target.type === 'integer') return 0;
    return target.description ? '' : 'string';
  }
  function render(entry) {
    selected = entry;
    document.querySelectorAll('.route').forEach(node => node.classList.toggle('selected', node.dataset.key === entry.method+entry.path));
    const bodySpec = entry.operation.requestBody?.content?.['application/json'];
    const isChatTurn = entry.method === 'post' && entry.path === '/v1/desktop/turns';
    const bodyValue = bodySpec ? exampleFor(bodySpec) : undefined;
    if (isChatTurn) { bodyValue.prompt = ''; bodyValue.wait = true; bodyValue.stream = false; bodyValue.timeoutMs = 600000; }
    const body = bodySpec ? JSON.stringify(bodyValue, null, 2) : '';
    const pathParams = (entry.operation.parameters || []).filter(param => param.in === 'path');
    const queryParams = (entry.operation.parameters || []).filter(param => param.in === 'query');
    workspace.innerHTML = '<div class="eyebrow">'+esc((entry.operation.tags || ['API'])[0])+'</div><h1>'+esc(entry.operation.summary || entry.operation.operationId || entry.path)+'</h1><p class="summary">'+esc(entry.operation.description || 'Call this endpoint against the running Headless Codex worker.')+'</p><div class="request-line"><span class="method '+entry.method+'">'+entry.method.toUpperCase()+'</span><span>'+esc(entry.path)+'</span></div>'+
      pathParams.map(param => '<div class="field"><label>'+esc(param.name)+' · path parameter</label><input data-path-param="'+esc(param.name)+'" placeholder="'+esc(param.description || param.name)+'"></div>').join('')+
      queryParams.map(param => '<div class="field"><label>'+esc(param.name)+' · query parameter</label><input data-query-param="'+esc(param.name)+'" placeholder="'+esc(param.description || param.name)+'"></div>').join('')+
      (isChatTurn ? '<div class="field"><label for="chat-message">Message · ⌘Enter to send</label><textarea id="chat-message" rows="4" placeholder="Type a message for Codex…"></textarea></div>' : '')+
      (bodySpec ? '<div class="field"><label>Request body · application/json</label><textarea id="request-body" rows="10">'+esc(body)+'</textarea></div>' : '')+
      '<div class="actions"><button id="send" class="primary" data-idle-label="'+(isChatTurn ? 'Send message' : 'Send request')+'">'+(isChatTurn ? 'Send message' : 'Send request')+'</button><button id="copy-curl">Copy cURL</button></div><div class="response"><div class="response-head"><strong>Response</strong><span id="response-status" class="label">Not sent</span></div><pre id="response-body" class="code">Choose “'+(isChatTurn ? 'Send message' : 'Send request')+'” to call the live API.</pre></div>';
    document.getElementById('send').onclick = send;
    if (isChatTurn) {
      const message = document.getElementById('chat-message');
      message.addEventListener('input', event => {
        const requestBody = document.getElementById('request-body');
        try { const value = JSON.parse(requestBody.value); value.prompt = event.currentTarget.value; requestBody.value = JSON.stringify(value, null, 2); } catch {}
      });
      message.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || !event.metaKey) return;
        event.preventDefault();
        const button = document.getElementById('send');
        if (!button.disabled) button.click();
      });
    }
    document.getElementById('copy-curl').onclick = copyCurl;
  }
  function requestParts() {
    let path = selected.path;
    document.querySelectorAll('[data-path-param]').forEach(input => { path = path.replace('{'+input.dataset.pathParam+'}', encodeURIComponent(input.value)); });
    const url = new URL(path, location.origin);
    document.querySelectorAll('[data-query-param]').forEach(input => { if(input.value) url.searchParams.set(input.dataset.queryParam, input.value); });
    const raw = document.getElementById('request-body')?.value.trim();
    return {url, raw};
  }
  async function send() {
    const output = document.getElementById('response-body'); const responseStatus = document.getElementById('response-status'); const button = document.getElementById('send');
    button.disabled = true; button.textContent = 'Sending…'; output.textContent = 'Waiting for Headless Codex…';
    try { const {url,raw} = requestParts(); const headers = {}; if(raw) headers['content-type']='application/json'; const response = await fetch(url,{method:selected.method.toUpperCase(),headers,body:raw||undefined}); const text = await response.text(); responseStatus.textContent = response.status+' '+response.statusText; output.textContent = (()=>{try{return JSON.stringify(JSON.parse(text),null,2)}catch{return text}})(); }
    catch(error){ responseStatus.textContent='Request failed'; output.textContent=error.message||String(error); }
    finally{ button.disabled=false; button.textContent=button.dataset.idleLabel||'Send request'; }
  }
  async function copyCurl(event) { const {url,raw}=requestParts(); let command="curl -i -X "+selected.method.toUpperCase()+" '"+url+"'"; if(raw) command+=" -H 'Content-Type: application/json' --data '"+raw.replace(/'/g,"'\\''")+"'"; await navigator.clipboard.writeText(command); event.currentTarget.textContent='Copied'; setTimeout(()=>event.currentTarget.textContent='Copy cURL',1000); }
  async function load() {
    status.textContent='Loading'; status.className='status';
    try { const response=await fetch('/v1/openapi.json'); if(!response.ok) throw new Error('OpenAPI '+response.status); schema=await response.json(); renderRoutes(); status.textContent=apiEntries.length+' endpoints'; status.className='status ready'; if(apiEntries[0]) render(apiEntries.find(item=>item.path==='/v1/health')||apiEntries[0]); }
    catch(error){status.textContent='Disconnected';workspace.innerHTML='<div class="empty">'+esc(error.message||error)+'</div>';}
  }
  document.getElementById('reconnect-viewer').onclick=connectViewer;
  document.querySelectorAll('[data-pane]').forEach(button=>button.onclick=()=>document.body.classList.toggle('show-desktop',button.dataset.pane==='desktop'));
  connectViewer(); load();
</script>
</body>
</html>`;
}
