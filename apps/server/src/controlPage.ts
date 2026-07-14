// Minimal Phase 1A control page: runner status, live log stream, and the
// default control set (interrupt/cancel primary; others advanced — PRD R4).
// Replaced by the real @norns/web app from Phase 4 onward.
export function controlPageHtml(): string {
  return `<!doctype html>
<meta charset="utf-8"><title>TheNorns — Runner Control</title>
<style>
body{font-family:ui-monospace,monospace;margin:2rem;background:#111;color:#ddd}
button{margin:0 .25rem .25rem 0}
#log{background:#000;padding:1rem;height:40vh;overflow:auto;white-space:pre-wrap}
.ok{color:#7c7}.bad{color:#c77}
</style>
<h1>TheNorns — Runner Control (Phase 1A)</h1>
<p>Session token: <input id="tok" type="password"> <button onclick="init()">Connect</button></p>
<div id="runners"></div>
<p>
<button onclick="cmd('launch_fixture',{fixture:'count:20:250'})">Launch fixture</button>
<button onclick="cmd('interrupt',{run_id:runId()})">Interrupt</button>
<button onclick="cmd('cancel',{run_id:runId()})">Cancel</button>
<details style="display:inline"><summary>Advanced</summary>
<button onclick="cmd('resume_session',{run_id:runId()})">Resume</button>
<button onclick="cmd('suspend',{run_id:runId()})">Suspend</button>
<button onclick="cmd('stop_after_current',{run_id:runId()})">Stop after current</button>
</details>
</p>
<div id="log"></div>
<script>
let token="", runner="", lastRun="";
function runId(){return lastRun}
function logLine(s,c){const d=document.getElementById("log");d.innerHTML+='<span class="'+(c||"")+'">'+s+"</span>\\n";d.scrollTop=d.scrollHeight}
async function init(){
  token=document.getElementById("tok").value;
  const rs=await (await fetch("/api/runners",{headers:{authorization:"Bearer "+token}})).json();
  document.getElementById("runners").textContent="Runners: "+rs.map(r=>r.runner_id+(r.connected?" [online]":" [offline]")).join(", ");
  if(rs[0]) runner=rs[0].runner_id;
  const ws=new WebSocket((location.protocol==="https:"?"wss":"ws")+"://"+location.host+"/ws/session?token="+encodeURIComponent(token));
  ws.onmessage=(m)=>{const f=JSON.parse(m.data);
    if(f.type==="log"){lastRun=f.run_id;logLine(f.chunk)}
    else if(f.type==="run_status"){lastRun=f.run_id;logLine("[run "+f.run_id+" "+f.status+"]", "ok")}
    else if(f.type==="command_state"){logLine("[cmd "+f.command_id+" -> "+f.state+"]","ok")}
    else if(f.type==="runner_status"){logLine("[runner "+f.runner_id+(f.connected?" connected":" disconnected")+"]",f.connected?"ok":"bad")}};
}
async function cmd(kind,rest){
  const payload=Object.assign({kind:kind},rest);
  if(kind==="launch_fixture"){payload.fixture=rest.fixture}
  const res=await fetch("/api/commands",{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify({runner_id:runner,payload:payload})});
  const body=await res.json();
  logLine("[issued "+kind+" -> "+(body.command_id||JSON.stringify(body))+"]","ok");
}
</script>`;
}
