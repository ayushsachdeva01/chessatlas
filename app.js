const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const PIECE_ASSETS={
  w:{p:"pawn-w.svg",n:"knight-w.svg",b:"bishop-w.svg",r:"rook-w.svg",q:"queen-w.svg",k:"king-w.svg"},
  b:{p:"pawn-b.svg",n:"knight-b.svg",b:"bishop-b.svg",r:"rook-b.svg",q:"queen-b.svg",k:"king-b.svg"}
};
function pieceMarkup(color,type){
  const src=`assets/pieces/${PIECE_ASSETS[color][type]}`;
  return `<img class="piece-img ${color}" src="${src}" draggable="false" alt="" aria-hidden="true">`;
}
let openings=[], progress=JSON.parse(localStorage.getItem("chessAtlasProgress")||"{}");
let puzzles=JSON.parse(localStorage.getItem("chessAtlasPuzzles")||"null")||[];
let currentView="home", currentOpening=null, currentLine=null, chess=null, selected=null, lineIndex=0, boardFlipped=false, sessionMistake=false;
let puzzleIndex=0,puzzleState=null,puzzleFlipped=false,serverPuzzleDB=false;
let puzzleSessionSolved=0,puzzleSessionTotal=0,puzzleSessionPosition=0;
let puzzleSessionResults=[];
let puzzleCurrentOutcome="pending";
let puzzleProfile=JSON.parse(localStorage.getItem("chessAtlasPuzzleProfile")||"null")||{name:"Carneceria07",elo:"1044",avatar:"assets/profile-avatar.svg"};
let replyTimer=null;
function updatePuzzleProgress(){
  const total=puzzleSessionTotal||1;
  const results=Array.from({length:total},(_,i)=>puzzleSessionResults[i]||"pending");
  const solved=results.filter(x=>x==="correct").length;
  const label=`${solved} / ${total}`;
  const score=$("#puzzleScore"); if(score)score.textContent=label;
  const num=$("#puzzleProgressNumber"); if(num)num.textContent=label;
  const rail=$("#puzzleProgressDots");
  if(rail){
    rail.innerHTML=results.map((state,i)=>{
      const icon=state==="correct"?"✓":state==="wrong"?"×":state==="solution"?"!":String(i+1);
      return `<button type="button" class="session-dot ${state} ${i===puzzleSessionPosition?"current":""}" data-session-index="${i}" title="Go to puzzle ${i+1}">${icon}</button>`;
    }).join("");
    rail.querySelectorAll("[data-session-index]").forEach(b=>b.onclick=()=>jumpToSessionPuzzle(Number(b.dataset.sessionIndex)));
  }
  const count=$("#sessionCount"); if(count)count.textContent=`Puzzle ${puzzleSessionPosition+1} of ${total}`;
}

function finalizeCurrentPuzzleOutcome(outcome){
  if(!puzzleState)return;
  if(outcome==="wrong") puzzleCurrentOutcome="wrong";
  else if(outcome==="solution") puzzleCurrentOutcome="solution";
  else if(outcome==="correct" && puzzleCurrentOutcome==="pending") puzzleCurrentOutcome="correct";
  puzzleSessionResults[puzzleSessionPosition]=puzzleCurrentOutcome;
  updatePuzzleProgress();
}

function advancePuzzleSession(){
  if(!puzzleState)return;
  puzzleSessionResults[puzzleSessionPosition]=puzzleCurrentOutcome;
  const next=(puzzleSessionPosition+1)%puzzleSessionTotal;
  puzzleSessionPosition=next;
  puzzleIndex=next%puzzleState.pool.length;
  puzzleCurrentOutcome=puzzleSessionResults[next]||"pending";
  startPuzzle(puzzleState.pool,{preserveSession:true});
}

function jumpToSessionPuzzle(index){
  if(!puzzleState||index<0||index>=puzzleSessionTotal)return;
  puzzleSessionResults[puzzleSessionPosition]=puzzleCurrentOutcome;
  puzzleSessionPosition=index;
  puzzleIndex=index%puzzleState.pool.length;
  puzzleCurrentOutcome=puzzleSessionResults[index]||"pending";
  startPuzzle(puzzleState.pool,{preserveSession:true});
}



/* ================================================================
   LOCAL BROWSER STOCKFISH
   No Python server required. Stockfish.js runs in a Web Worker.
   ================================================================ */
const LOCAL_STOCKFISH_URL="https://cdn.jsdelivr.net/npm/stockfish@18.0.8/src/stockfish-18-lite-single.js";
let localEngineWorker=null, localEngineReady=null, localEngineBusy=false, localEngineWaiters=[];
function localEngineStart(){
  if(localEngineReady)return localEngineReady;
  localEngineReady=new Promise((resolve,reject)=>{
    try{
      localEngineWorker=new Worker(LOCAL_STOCKFISH_URL);
      let booted=false;
      localEngineWorker.onmessage=e=>{
        const line=String(e.data||"");
        if(line==="uciok"&&!booted){booted=true;resolve();return}
        if(line.startsWith("bestmove ")){
          const waiter=localEngineWaiters.shift();
          if(waiter)waiter.finish(line);
        }else{
          const waiter=localEngineWaiters[0];
          if(waiter)waiter.info(line);
        }
      };
      localEngineWorker.onerror=e=>{reject(new Error("Browser Stockfish could not load. Check your internet connection or allow cdn.jsdelivr.net."));localEngineReady=null};
      localEngineWorker.postMessage("uci");
    }catch(e){reject(e);localEngineReady=null}
  });
  return localEngineReady;
}
async function localEngineAnalyze(fen,{depth=12,elo=null,limitStrength=false}={}){
  await localEngineStart();
  if(localEngineBusy)await new Promise(r=>{const t=setInterval(()=>{if(!localEngineBusy){clearInterval(t);r()}},20)});
  localEngineBusy=true;
  return new Promise((resolve,reject)=>{
    let latest=null;
    const waiter={
      info(line){
        const m=line.match(/score (cp|mate) (-?\d+)/);
        if(m){
          const type=m[1],raw=Number(m[2]);
          const turn=fen.split(/\s+/)[1];
          const value=turn==="w"?raw:-raw;
          latest={type,value};
        }
      },
      finish(line){
        const best=(line.match(/^bestmove\s+(\S+)/)||[])[1]||"0000";
        localEngineBusy=false;
        resolve({bestmove:best,score:latest||{type:"cp",value:0}});
      }
    };
    localEngineWaiters.push(waiter);
    try{
      if(limitStrength&&elo!=null&&elo<1320){
        localEngineWorker.postMessage("setoption name UCI_LimitStrength value false");
        localEngineWorker.postMessage(`setoption name Skill Level value ${Math.max(0,Math.min(4,Math.floor((elo-100)/300)))}`);
      }else if(limitStrength&&elo!=null){
        localEngineWorker.postMessage("setoption name UCI_LimitStrength value true");
        localEngineWorker.postMessage(`setoption name UCI_Elo value ${Math.max(1320,Math.min(3190,elo))}`);
      }else{
        localEngineWorker.postMessage("setoption name UCI_LimitStrength value false");
        localEngineWorker.postMessage("setoption name Skill Level value 20");
      }
      localEngineWorker.postMessage("ucinewgame");
      localEngineWorker.postMessage(`position fen ${fen}`);
      localEngineWorker.postMessage(`go depth ${depth}`);
    }catch(e){localEngineBusy=false;localEngineWaiters=localEngineWaiters.filter(x=>x!==waiter);reject(e)}
  });
}
function localEngineStop(){
  if(localEngineWorker)try{localEngineWorker.postMessage("stop")}catch{}
}

async function init(){
  openings=await fetch("data/openings.json").then(r=>r.json());
  $("#statOpenings").textContent=openings.length;
  $("#statLines").textContent=openings.reduce((a,o)=>a+o.lines.length,0);
  populateOpeningSelect(); renderOpenings(); renderReview(); updateStats();
  bindNav(); bindThemes(); bindHome(); bindOpening(); bindReview(); bindPuzzles(); bindLesson(); bindPuzzleSession(); bindGameReview(); bindProfileEditor();
  await autoLoadPuzzles();
}
function bindNav(){
  $$(".nav").forEach(b=>b.onclick=()=>showView(b.dataset.view));
  $$("[data-go]").forEach(b=>b.onclick=()=>showView(b.dataset.go));
}
function showView(v){
  currentView=v;
  document.body.classList.toggle("puzzle-mode",v==="puzzleSession"); $$(".view").forEach(x=>x.classList.remove("active")); $("#"+v).classList.add("active");
  $$(".nav").forEach(x=>x.classList.toggle("active",x.dataset.view===v));
  const topbar=$("#topbar");
  if(topbar) topbar.style.display=(v==="home")?"":"none";
  if(v==="home"){
    $("#pageTitle").textContent="Build opening memory, not just a repertoire.";
    $("#eyebrow").textContent="YOUR TRAINING ROOM";
  }
}
function bindThemes(){}
function bindHome(){
  $("#startReview").onclick=()=>startNextReview();
  $("#pathReview").onclick=()=>startNextReview();
  $("#topReview").onclick=()=>startNextReview();
}
function bindOpening(){
  $("#openingSearch").oninput=renderOpenings; $("#familyFilter").onchange=renderOpenings;
}
function bindReview(){
  $("#resetProgress").onclick=resetProgress;
}
function resetProgress(){
  if(confirm("Reset all opening memory progress?")){
    progress={};
    localStorage.removeItem("chessAtlasProgress");
    renderReview(); renderOpenings(); updateStats();
    flash("Progress reset.");
  }
}
function renderOpenings(){
  $("#openingBrowse").hidden=false;
  $("#openingDetail").hidden=true;
  const q=$("#openingSearch").value.toLowerCase().trim(), f=$("#familyFilter").value;
  const list=openings.filter(o=>(f==="all"||o.family===f)&&(!q||o.name.toLowerCase().includes(q)||o.summary.toLowerCase().includes(q)||(o.tags||[]).join(" ").toLowerCase().includes(q)));
  $("#academyLineCount").textContent=openings.reduce((a,o)=>a+o.lines.length,0);
  $("#openingGrid").innerHTML=list.map(o=>{
    const m=masteryFor(o);
    return `<article class="opening-card" data-id="${o.id}">
      <div class="opening-card-top"><span class="eco">${o.eco}</span><span class="difficulty ${o.difficulty.toLowerCase()}">${o.difficulty}</span></div>
      <div class="opening-family">${o.family}</div><h4>${o.name}</h4><p>${o.summary}</p>
      <div class="tags">${o.tags.map(t=>`<span class="tag">${t}</span>`).join("")}</div>
      <div class="opening-progress"><div><span>${o.lines.length} core lines</span><b>${m}%</b></div><div class="progress"><i style="width:${m}%"></i></div></div>
      <div class="opening-card-footer"><span>Study theory</span><span>→</span></div>
    </article>`
  }).join("") || `<div class="empty-state"><b>No openings found.</b><p>Try a different search or first-move filter.</p></div>`;
  $$(".opening-card").forEach(c=>c.onclick=()=>openOpening(c.dataset.id));
}
function openOpening(id){
  currentOpening=openings.find(o=>o.id===id);
  if(!currentOpening)return;
  $("#openingBrowse").hidden=true;
  const detail=$("#openingDetail"); detail.hidden=false;
  const mastered=masteryFor(currentOpening);
  detail.innerHTML=`
    <div class="detail-head">
      <button class="back" id="openingDetailBack">← Academy</button>
      <div class="detail-title"><span class="eyebrow">${currentOpening.family} · ${currentOpening.eco}</span><h2>${currentOpening.name}</h2><p>${currentOpening.summary}</p></div>
      <div class="detail-mastery"><strong>${mastered}%</strong><span>mastered</span></div>
    </div>
    <div class="opening-strategy-grid">
      <div class="strategy-card"><span>WHITE’S JOB</span><p>${currentOpening.strategy?.white||currentOpening.summary}</p></div>
      <div class="strategy-card"><span>BLACK’S JOB</span><p>${currentOpening.strategy?.black||'Develop efficiently, challenge the centre, and create active counterplay.'}</p></div>
    </div>
    <div class="section-heading compact"><div><span class="eyebrow">CORE THEORY</span><h3>${currentOpening.lines.length} study lines</h3></div><span class="section-note">Every move has a purpose note</span></div>
    <div class="line-library">${currentOpening.lines.map((l,i)=>{
      const san=[]; const t=new Chess();
      l.line.split(/\s+/).forEach(u=>{try{const m=t.move({from:u.slice(0,2),to:u.slice(2,4),promotion:u[4]||'q'});san.push(m?m.san:u)}catch{san.push(u)}});
      return `<article class="line-card"><div class="line-card-head"><div><span class="line-number">${String(i+1).padStart(2,'0')}</span><div><h4>${l.name}</h4><p>${l.idea}</p></div></div><button class="primary small" data-line="${i}">Study line →</button></div><div class="line-preview">${san.map((m,j)=>`<span>${Math.floor(j/2)+1}${j%2===0?'.':'…'} ${m}</span>`).join('')}</div><div class="line-memory">${l.whatToRemember}</div></article>`
    }).join('')}</div>`;
  $("#openingDetailBack").onclick=renderOpenings;
  $$("#openingDetail [data-line]").forEach(b=>b.onclick=()=>startLesson(currentOpening,currentOpening.lines[+b.dataset.line]));
}
function startLesson(o,l){
  currentOpening=o;currentLine=l;lineIndex=0;sessionMistake=false;selected=null;boardFlipped=false;
  chess=new Chess(); showView("lesson");
  $("#lessonFamily").textContent=`${o.family} · ${o.eco}`;
  $("#lessonName").textContent=o.name;$("#lessonVariant").textContent=l.name;
  $("#lessonMastery").textContent=masteryFor(o)+"%";
  $("#coachTitle").textContent="Your first task";$("#coachText").textContent=l.idea;
  $("#lessonRemember").textContent=l.whatToRemember||l.idea;
  $("#lessonWhitePlan").textContent=o.strategy?.white||o.summary;
  $("#lessonBlackPlan").textContent=o.strategy?.black||"Develop efficiently and challenge the centre.";
  renderMoveTheory();
  updateLesson();
}
function parseLine(line){return line.trim().split(/\s+/).filter(Boolean)}
function renderMoveTheory(){
  const moves=parseLine(currentLine.line), notes=currentLine.moveNotes||[];
  const t=new Chess(); const rows=[];
  moves.forEach((u,i)=>{
    let san=u; try{const m=t.move({from:u.slice(0,2),to:u.slice(2,4),promotion:u[4]||'q'}); if(m)san=m.san}catch{}
    rows.push(`<div class="move-theory-row ${i<lineIndex?'done':''} ${i===lineIndex?'current':''}"><span class="theory-index">${Math.floor(i/2)+1}${i%2===0?'.':'…'}</span><span class="theory-san">${san}</span><div><b>${i%2===0?'White':'Black'} move</b><p>${notes[i]||'Improve the position and prepare the next strategic step.'}</p></div></div>`);
  });
  $("#moveTheoryList").innerHTML=rows.join("");
}
function updateLesson(){
  drawBoard("#board",chess,boardFlipped,handleLessonSquare);
  const moves=parseLine(currentLine.line), total=moves.length;
  $("#lineStep").textContent=`${Math.min(lineIndex+1,total)} / ${total}`;
  $("#lineProgress i").style.width=(Math.min(lineIndex,total)/total*100)+"%";
  $("#turnText").textContent=chess.turn()==="w"?"White to move":"Black to move";
  const san=[];const t=new Chess();
  moves.forEach((u,i)=>{try{const m=t.move({from:u.slice(0,2),to:u.slice(2,4),promotion:u[4]||"q"});san.push(m?m.san:u)}catch{san.push(u)}});
  $("#moveList").innerHTML=san.map((m,i)=>`<span class="move-chip ${i<lineIndex?"correct":""} ${i===lineIndex?"current":""}">${i+1}${i%2===0?".":"..."} ${m}</span>`).join("");
  renderMoveTheory();
}
function attemptMove(game, from, to, expected, onWrong){
  if(!from || !to || from===to) return false;
  const legal=game.moves({square:from,verbose:true}).find(m=>m.to===to);
  if(!legal){ return false; }
  if(expected && (from+to)!==expected.slice(0,4)){
    if(onWrong) onWrong();
    return false;
  }
  return game.move({from,to,promotion:(expected&&expected[4])||"q"});
}

function handleLessonSquare(sq){
  if(lineIndex>=parseLine(currentLine.line).length)return;
  if(!selected){
    const p=chess.get(sq);
    if(p&&p.color===chess.turn()){
      selected=sq;
      updateLesson();
    }
    return;
  }
  const from=selected,to=sq;
  if(from===to){selected=null;updateLesson();return}
  const expected=parseLine(currentLine.line)[lineIndex];
  const moved=attemptMove(chess,from,to,expected,()=>{
    sessionMistake=true;
    flash("Not this time — this line comes back sooner.");
    $("#coachTitle").textContent="Remember the position";
    $("#coachText").textContent=`Expected ${expected.slice(0,4)} here. ${currentLine.idea}`;
  });
  selected=null;
  if(!moved){updateLesson();return}
  const note=(currentLine.moveNotes||[])[lineIndex]||currentLine.idea;
  lineIndex++;
  if(lineIndex>=parseLine(currentLine.line).length){
    $("#coachTitle").textContent="Line complete ✦";
    $("#coachText").textContent="You retrieved the entire sequence. Rate how well you remembered it.";
    $("#moveStatus").textContent="Session complete";
    flash(sessionMistake?"Good recovery.":"Clean recall.");
    updateLesson(); renderReview(); updateStats();
  } else {
    $("#coachTitle").textContent="Correct — now understand it";
    $("#coachText").textContent=note;
    updateLesson();
  }
}

function animateBoardMove(from,to){
  const board=$("#puzzleBoard");
  if(!board||!from||!to)return;
  const source=board.querySelector(`[data-piece-square="${from}"]`);
  const target=board.querySelector(`[data-piece-square="${to}"]`);
  if(!target)return;

  const sourcePiece=source?.querySelector(".piece-img");
  const targetPiece=target.querySelector(".piece-img");
  if(!targetPiece)return;

  const br=board.getBoundingClientRect(), size=br.width/8;
  const fx=from.charCodeAt(0)-97, fy=8-Number(from[1]);
  const tx=to.charCodeAt(0)-97, ty=8-Number(to[1]);
  const dx=(fx-tx)*size, dy=(fy-ty)*size;

  targetPiece.style.transition="none";
  targetPiece.style.transform=`translate(${dx}px,${dy}px)`;
  targetPiece.style.opacity="0.96";
  requestAnimationFrame(()=>{
    targetPiece.style.transition="transform 180ms cubic-bezier(.2,.75,.2,1), opacity 120ms ease";
    targetPiece.style.transform="translate(0,0)";
    targetPiece.style.opacity="1";
  });

  if(sourcePiece){
    sourcePiece.style.transition="opacity 120ms ease";
    sourcePiece.style.opacity="0";
  }

  const captured=target.querySelector(".piece-img:not(:scope .piece-img:last-child)");
  if(captured&&captured!==targetPiece){
    captured.style.transition="opacity 120ms ease, transform 120ms ease";
    captured.style.opacity="0";
    captured.style.transform="scale(.82)";
  }
}

function drawBoard(sel,game,flipped,click,selectedSq){
  const el=$(sel); if(!el||!game)return;
  el.innerHTML="";
  el.onpointerdown=null; el.onpointermove=null; el.onpointerup=null; el.onpointercancel=null;
  el.classList.remove("dragging");

  const files=flipped?["h","g","f","e","d","c","b","a"]:["a","b","c","d","e","f","g","h"];
  const ranks=flipped?[1,2,3,4,5,6,7,8]:[8,7,6,5,4,3,2,1];

  const rankAxis=$("#rankAxis"), fileAxis=$("#fileAxis");
  if(rankAxis) rankAxis.innerHTML=ranks.map(r=>`<span>${r}</span>`).join("");
  if(fileAxis) fileAxis.innerHTML=files.map(f=>`<span>${f}</span>`).join("");

  const legalTargets=new Map();
  if(selectedSq){
    for(const m of game.moves({square:selectedSq,verbose:true})){
      legalTargets.set(m.to,m.captured?"capture":"target");
    }
  }

  for(let row=0;row<8;row++){
    const r=ranks[row];
    for(let col=0;col<8;col++){
      const f=files[col], sq=f+r, p=game.get(sq);
      const div=document.createElement("div");
      div.className=`sq ${((col+row)%2===0)?"light":"dark"}${selectedSq===sq?" selected":""}`;
      if(legalTargets.has(sq)) div.classList.add(legalTargets.get(sq));
      div.dataset.square=sq;

      if(p){
        const holder=document.createElement("div");
        holder.className="piece-wrap";
        holder.innerHTML=pieceMarkup(p.color,p.type);
        holder.dataset.pieceSquare=sq;
        div.appendChild(holder);
      }

      // Coordinates live directly on the edge squares so they remain visible
      // without stealing space from the board.
      if(row===7){
        const fileLabel=document.createElement("span");
        fileLabel.className="board-coord file";
        fileLabel.textContent=f;
        div.appendChild(fileLabel);
      }
      if(col===0){
        const rankLabel=document.createElement("span");
        rankLabel.className="board-coord rank";
        rankLabel.textContent=r;
        div.appendChild(rankLabel);
      }

      div.onclick=()=>{if(!suppressClick)click(sq)};
      el.appendChild(div);
    }
  }

  let drag={from:null,piece:null,pointerId:null,moved:false,ghost:null};
  let suppressClick=false;

  const clearDrag=()=>{
    if(drag.ghost)drag.ghost.remove();
    if(drag.from){
      const src=el.querySelector(`[data-piece-square="${drag.from}"]`);
      if(src)src.classList.remove("drag-source-hidden");
    }
    drag={from:null,piece:null,pointerId:null,moved:false,ghost:null};
    el.classList.remove("dragging");
  };

  const updateGhost=(e)=>{
    if(!drag.ghost)return;
    drag.ghost.style.left=`${e.clientX}px`;
    drag.ghost.style.top=`${e.clientY}px`;
  };

  el.onpointerdown=e=>{
    if(e.button!==0)return;
    const sq=e.target.closest(".sq")?.dataset.square;
    if(!sq)return;
    const piece=game.get(sq);
    if(!piece||piece.color!==game.turn())return;

    e.preventDefault();
    suppressClick=true;
    drag.from=sq;
    drag.piece=piece;
    drag.pointerId=e.pointerId;

    try{el.setPointerCapture(e.pointerId)}catch{}

    const ghost=document.createElement("div");
    ghost.className="drag-ghost";
    ghost.innerHTML=pieceMarkup(piece.color,piece.type);
    const boardSize=el.getBoundingClientRect().width;
    ghost.style.width=`${boardSize/8}px`;
    ghost.style.height=`${boardSize/8}px`;
    document.body.appendChild(ghost);
    drag.ghost=ghost;

    const src=el.querySelector(`[data-piece-square="${sq}"]`);
    if(src)src.classList.add("drag-source-hidden");

    selected=sq;
    el.querySelectorAll(".sq.selected,.sq.target,.sq.capture").forEach(x=>x.classList.remove("selected","target","capture"));
    const selectedEl=el.querySelector(`[data-square="${sq}"]`);
    if(selectedEl)selectedEl.classList.add("selected");
    for(const m of game.moves({square:sq,verbose:true})){
      const targetEl=el.querySelector(`[data-square="${m.to}"]`);
      if(targetEl)targetEl.classList.add(m.captured?"capture":"target");
    }
    updateGhost(e);
  };

  el.onpointermove=e=>{
    if(drag.pointerId!==e.pointerId||!drag.from)return;
    e.preventDefault();
    const rect=el.getBoundingClientRect();
    const size=rect.width/8;
    const fileIndex=files.indexOf(drag.from[0]);
    const rankIndex=ranks.indexOf(Number(drag.from[1]));
    const originX=rect.left+(fileIndex+.5)*size;
    const originY=rect.top+(rankIndex+.5)*size;
    if(Math.hypot(e.clientX-originX,e.clientY-originY)>4)drag.moved=true;
    if(drag.moved){
      el.classList.add("dragging");
      updateGhost(e);
    }
  };

  el.onpointerup=e=>{
    if(drag.pointerId!==e.pointerId||!drag.from)return;
    e.preventDefault();

    const from=drag.from;
    const moved=drag.moved;
    const rect=el.getBoundingClientRect();
    const size=rect.width/8;
    const col=Math.max(0,Math.min(7,Math.floor((e.clientX-rect.left)/size)));
    const row=Math.max(0,Math.min(7,Math.floor((e.clientY-rect.top)/size)));
    const to=files[col]+ranks[row];

    clearDrag();

    if(moved){
      suppressClick=true;
      selected=from;
      click(to);
      setTimeout(()=>{suppressClick=false},0);
    }else{
      selected=from;
    }
    setTimeout(()=>{suppressClick=false},0);
  };

  el.onpointercancel=()=>{
    clearDrag();
    suppressClick=false;
  };
}

function bindLesson(){
  $("#lessonBack").onclick=()=>showView("openings");$("#flipBoard").onclick=()=>{boardFlipped=!boardFlipped;updateLesson()};$("#resetBoard").onclick=()=>{chess=new Chess();lineIndex=0;sessionMistake=false;selected=null;updateLesson()};
  $$("#ratingRow .grade").forEach(b=>b.onclick=()=>{if(!currentOpening)return;const g=b.dataset.grade;scheduleLine(currentOpening.id,currentLine.name,g);flash(`Saved: ${g}.`);renderReview();updateStats();startNextReview()});
}
function key(o,l){return `${o}|${l}`}
function scheduleLine(o,l,grade){
  const k=key(o,l), old=progress[k]||{box:0,next:0,reviews:0,mastered:false};
  const intervals={again:10*60*1000,hard:24*3600*1000,good:3*24*3600*1000,easy:7*24*3600*1000};
  let box=old.box+(grade==="again"?-1:grade==="hard"?0:1);box=Math.max(0,Math.min(5,box));
  const next=Date.now()+intervals[grade];progress[k]={box,next,reviews:old.reviews+1,lastReview:Date.now(),mastered:box>=4};
  localStorage.setItem("chessAtlasProgress",JSON.stringify(progress));
}
function dueItems(){return openings.flatMap(o=>o.lines.map(l=>({o,l,p:progress[key(o.id,l.name)]||{next:0}}))).filter(x=>!x.p.next||x.p.next<=Date.now())}
function startNextReview(){const due=dueItems();if(!due.length){flash("You're caught up. Pick a new opening line.");showView("openings");return}const x=due[Math.floor(Math.random()*due.length)];startLesson(x.o,x.l)}
function renderReview(){
  const due=dueItems();
  const startOfDay=new Date(); startOfDay.setHours(0,0,0,0);
  const reviewedToday=Object.values(progress).filter(x=>x.lastReview&&x.lastReview>=startOfDay.getTime()).length;
  $("#reviewBadge").textContent=due.length;$("#todayCount").textContent=reviewedToday;
  $("#reviewDueCount").textContent=due.length;
  $("#reviewMasteredCount").textContent=Object.values(progress).filter(x=>x.mastered).length;
  const totalLines=openings.reduce((a,o)=>a+o.lines.length,0);
  $("#reviewCoverage").textContent=(totalLines?Math.round(Object.values(progress).filter(x=>x.reviews).length/totalLines*100):0)+"%";
  $("#reviewList").innerHTML=due.length?due.slice(0,20).map(x=>`<div class="review-item"><div class="review-item-main"><span class="review-dot"></span><div><b>${x.o.name}</b><strong>${x.l.name}</strong><span>${x.l.idea}</span></div></div><span class="due">DUE</span><button class="secondary small" data-r="${x.o.id}|${x.l.name}">Review →</button></div>`).join(""):`<div class="empty"><b>No urgent reviews.</b><p>Learn a new line or come back later. The queue will bring weak lines forward automatically.</p></div>`;
  $$("#reviewList button").forEach(b=>{b.onclick=()=>{const [id,name]=b.dataset.r.split("|");const o=openings.find(x=>x.id===id);startLesson(o,o.lines.find(l=>l.name===name))}});
}
function masteryFor(o){const vals=o.lines.map(l=>progress[key(o.id,l.name)]?.box||0);return Math.round(vals.reduce((a,b)=>a+b,0)/(vals.length||1)/5*100)}
function updateStats(){const mastered=Object.values(progress).filter(x=>x.mastered).length;$("#statMastered").textContent=mastered;$("#todayProgress").style.width=Math.min(100,(Object.values(progress).filter(x=>x.reviews).length/10)*100)+"%";if(!serverPuzzleDB){$("#statPuzzles").textContent=puzzles.length?puzzles.length.toLocaleString():"Checking…";$("#puzzleStatSub").textContent=puzzles.length?"loaded locally":"detecting database";}$("#reviewBadge").textContent=dueItems().length}
function populateOpeningSelect(){
  $("#pOpening").innerHTML='<option value="all">Any opening</option>'+openings.map(o=>`<option value="${o.name}">${o.name}</option>`).join("");
}
function bindPuzzles(){
  $("#startPuzzle").onclick=startPuzzles;
  $("#pRating").onchange=updatePuzzleCount;
  $("#pTheme").onchange=updatePuzzleCount;
  $("#pOpening").onchange=updatePuzzleCount;
}
async function autoLoadPuzzles(){
  // GitHub Pages has no Python API. If a local puzzle dataset is supplied,
  // the normal puzzle UI can use it; otherwise leave Puzzle Lab available
  // without blocking the rest of the application.
  try{
    const r=await fetch("data/puzzles.json",{cache:"no-store"});
    if(r.ok){puzzles=await r.json();$("#statPuzzles").textContent=puzzles.length.toLocaleString();serverPuzzleDB=false;return}
  }catch{}
  $("#puzzleStatSub").textContent="Add your puzzle dataset to enable Puzzle Lab on GitHub Pages";
}
function filteredPuzzles(){
  let a=puzzles, r=$("#pRating").value,t=$("#pTheme").value,o=$("#pOpening").value;
  if(r&&r!=="all"){const [lo,hi]=r.split("-").map(Number);a=a.filter(p=>p.rating>=lo&&p.rating<hi)}
  if(t&&t!=="all")a=a.filter(p=>(p.themes||"").toLowerCase().split(/\s+/).includes(t.toLowerCase()));
  if(o&&o!=="all")a=a.filter(p=>(p.opening||"").includes(o.replaceAll(" ","_"))||p.opening===o);
  return a;
}
async function updatePuzzleCount(){
  $("#puzzleCount").textContent=filteredPuzzles().length.toLocaleString();
}

async function startPuzzles(){
  const pool=filteredPuzzles();
  if(!pool.length){flash("No local puzzles match those filters. Add data/puzzles.json for GitHub Pages.");return}
  puzzleSessionTotal=Math.min(10,pool.length);
  puzzleSessionResults=Array(puzzleSessionTotal).fill(null);
  puzzleSessionPosition=0;puzzleSessionSolved=0;puzzleIndex=0;puzzleCurrentOutcome="pending";
  startPuzzle(pool,{preserveSession:true});
}
function startPuzzle(pool,{preserveSession=false}={}){
  selected=null;
  if(!preserveSession){
    puzzleSessionTotal=Math.min(10,pool.length);
    puzzleSessionResults=Array(puzzleSessionTotal).fill(null);
    puzzleSessionPosition=0;
  }
  puzzleCurrentOutcome=puzzleSessionResults[puzzleSessionPosition]||"pending";
  if(replyTimer){clearTimeout(replyTimer);replyTimer=null;}
  puzzleState={
    pool,
    index:puzzleIndex,
    puzzle:pool[puzzleIndex],
    chess:new Chess(),
    step:0,
    solved:false,
    userMoves:[],
    solutionRevealed:false,
    timeline:[],
    viewIndex:0,
    analysisMoves:[]
  };
  showView("puzzleSession");
  updatePuzzleProgress();
  renderPuzzle();
}

function puzzleSolutionSAN(p){
  const moves=parseLine(p.moves), t=new Chess(), sans=[];
  try{t.load(p.fen)}catch{return moves.slice(1)}
  try{t.move({from:moves[0].slice(0,2),to:moves[0].slice(2,4),promotion:moves[0][4]||"q"})}catch{}
  for(const u of moves.slice(1)){
    try{
      const m=t.move({from:u.slice(0,2),to:u.slice(2,4),promotion:u[4]||"q"});
      sans.push(m?m.san:u);
    }catch{sans.push(u)}
  }
  return sans;
}

function renderPuzzleSolution(){
  if(!puzzleState)return;
  const box=$("#puzzleSolutionBox");
  if(!box)return;
  if(puzzleState.solutionRevealed){
    const sans=puzzleSolutionSAN(puzzleState.puzzle);
    box.innerHTML=`<div class="solution-reveal-state"><span class="solution-symbol">!</span><div><strong>Solution shown</strong><small>Use it to understand the tactical idea, not just memorize the moves.</small></div></div><div class="solution-line">${sans.map((m,i)=>`<span><b>${Math.floor(i/2)+1}${i%2===0?".":"…"}</b>${m}</span>`).join("")}</div><button class="solution-link" id="hideSolutionInline">Hide solution</button>`;
    $("#revealSolution").textContent="Solution shown";
    $("#revealSolution").classList.add("is-revealed");
    $("#hideSolutionInline").onclick=()=>{puzzleState.solutionRevealed=false;renderPuzzleSolution()};
  }else{
    box.innerHTML=`<div class="solution-locked"><span class="solution-symbol">?</span><div><strong>Need help?</strong><small>Reveal the best line only after you've calculated.</small></div></div>`;
    $("#revealSolution").textContent="Show solution";
    $("#revealSolution").classList.remove("is-revealed");
  }
}


function historyNode(id){
  return puzzleState?.historyNodes?.find(n=>n.id===id)||null;
}

function createHistoryNode(fen,san="",user=false,parentId=null,branchLabel="",from="",to=""){
  const node={
    id:puzzleState.historyNodeSeq++,
    fen,san,user,parentId,
    children:[],
    branchLabel,
    from,
    to
  };
  puzzleState.historyNodes.push(node);
  if(parentId!==null){
    const parent=historyNode(parentId);
    if(parent)parent.children.push(node.id);
  }
  puzzleState.currentNodeId=node.id;
  return node;
}

function renderPuzzleHistory(){
  const el=$("#puzzleMoves"); if(!el||!puzzleState)return;
  const nodes=(puzzleState.historyNodes||[]).filter(n=>n.san);
  if(!nodes.length){
    el.innerHTML=`<div class="timeline-empty"><span>○</span><div><strong>Your line is empty</strong><small>Play a move and the sequence will appear here.</small></div></div>`;
    return;
  }
  const pairs=[];
  for(let i=0;i<nodes.length;i+=2)pairs.push([nodes[i],nodes[i+1]||null]);
  el.innerHTML=`<div class="move-grid-head"><span>#</span><span>WHITE</span><span>BLACK</span></div>`+pairs.map((pair,i)=>{
    const [w,b]=pair;
    const cell=(n)=>n?`<button type="button" class="move-cell ${n.user?"user":"reply"} ${n.id===puzzleState.currentNodeId?"active":""}" data-history-id="${n.id}"><span>${n.san}</span><em>${n.user?"YOU":"REPLY"}</em></button>`:`<span class="move-cell empty-cell">—</span>`;
    return `<div class="move-grid-row"><span class="move-number">${i+1}.</span>${cell(w)}${cell(b)}</div>`;
  }).join("");
  el.querySelectorAll("[data-history-id]").forEach(btn=>btn.onclick=()=>jumpToHistoryNode(Number(btn.dataset.historyId)));
  const active=el.querySelector(".move-cell.active"); if(active)active.scrollIntoView({block:"nearest",behavior:"smooth"});
}


function jumpToHistoryNode(id){
  const node=historyNode(id);
  if(!node)return;
  const old=historyNode(puzzleState.currentNodeId);
  const g=new Chess();
  try{g.load(node.fen)}catch{return}
  const movingBack=old&&old.parentId===node.id;
  const movingForward=node.parentId===old?.id;
  puzzleState.chess=g;
  puzzleState.currentNodeId=node.id;
  selected=null;
  const idx=puzzleState.timeline.findIndex(x=>x.nodeId===node.id);
  if(idx>=0)puzzleState.viewIndex=idx;
  drawBoard("#puzzleBoard",g,puzzleFlipped,handlePuzzleSquare);
  renderCapturedPieces(g);
  const live=node.id===puzzleState.historyNodes[puzzleState.historyNodes.length-1].id;
  $("#puzzleTurn").textContent=puzzleState.solved
    ? `Reviewing position · ${g.turn()==="w"?"White":"Black"} to move`
    : (live ? (g.turn()==="w"?"White to move":"Black to move") : `Reviewing ${node.san}`);
  updatePuzzleNavigation();
  renderPuzzleHistory();
  resetEvaluation();
  scheduleAutoAnalysis();
  const from=movingBack?node.to:(movingForward?node.from:"");
  const to=movingBack?node.from:(movingForward?node.to:"");
  if(from&&to){
    const board=$("#puzzleBoard");
    board.classList.remove("history-jump");
    void board.offsetWidth;
    board.classList.add("history-jump");
    animateBoardMove(from,to);
    setTimeout(()=>board.classList.remove("history-jump"),360);
  }
}


function recordPuzzlePosition(san="",user=false,from="",to=""){
  if(!puzzleState)return;
  const parentId=puzzleState.currentNodeId;
  const node=createHistoryNode(puzzleState.chess.fen(),san,user,parentId,"",from,to);
  puzzleState.timeline.push({fen:node.fen,san,user,nodeId:node.id});
  puzzleState.viewIndex=puzzleState.timeline.length-1;
  renderPuzzleHistory();
  updatePuzzleNavigation();
}

function getCapturedPieces(game){
  const full={p:8,n:2,b:2,r:2,q:1,k:1};
  const counts={w:{p:0,n:0,b:0,r:0,q:0,k:0},b:{p:0,n:0,b:0,r:0,q:0,k:0}};
  for(const sq of ["a","b","c","d","e","f","g","h"].flatMap(f=>[1,2,3,4,5,6,7,8].map(r=>f+r))){const p=game.get(sq);if(p)counts[p.color][p.type]++;}
  const captured={w:[],b:[]};
  for(const color of ["w","b"]){for(const type of Object.keys(full)){const missing=full[type]-counts[color][type];for(let i=0;i<missing;i++)captured[color].push(type);}}
  return captured;
}
function renderCapturedPieces(game){
  const c=getCapturedPieces(game);
  const order={q:0,r:1,b:2,n:3,p:4};
  ["w","b"].forEach(color=>{const el=$("#captured"+(color==="w"?"White":"Black"));if(!el)return;el.innerHTML=c[color].sort((a,b)=>order[a]-order[b]).map(t=>pieceMarkup(color,t)).join("")||`<span class="captured-none">—</span>`;});
  const score=(arr)=>arr.reduce((s,t)=>s+({p:1,n:3,b:3,r:5,q:9,k:0}[t]||0),0);
  const whiteScore=score(c.w),blackScore=score(c.b);
  const diff=$("#materialDiff"); if(diff){const d=whiteScore-blackScore;diff.textContent=d===0?"Even":`${d>0?"White":"Black"} +${Math.abs(d)}`;}
}

function renderPuzzle(){
  const p=puzzleState.puzzle, moves=parseLine(p.moves), base=new Chess();
  selected=null;
  resetEvaluation();

  try{base.load(p.fen)}
  catch(e){console.error("Invalid puzzle FEN",p.fen,e);flash("Invalid puzzle position.");return}

  const setupMove=moves[0];
  try{
    base.move({from:setupMove.slice(0,2),to:setupMove.slice(2,4),promotion:setupMove[4]||"q"});
  }catch(e){
    console.error("Invalid puzzle setup move",setupMove,e);
    flash("Puzzle setup could not be applied.");
    return;
  }

  puzzleState.chess=base;
  puzzleState.step=1;
  puzzleState.solved=false;
  puzzleState.userMoves=[];
  puzzleState.solutionRevealed=false;
  puzzleState.analysisMoves=[];
  puzzleState.timeline=[];
  puzzleState.viewIndex=0;
  puzzleState.historyNodes=[];
  puzzleState.historyNodeSeq=0;

  const root=createHistoryNode(base.fen(),"",false,null);
  puzzleState.timeline=[{fen:base.fen(),san:"",user:false,nodeId:root.id}];
  puzzleState.viewIndex=0;

  drawBoard("#puzzleBoard",base,puzzleFlipped,handlePuzzleSquare);
  renderCapturedPieces(base);
  $("#puzzleMeta").textContent=`${p.rating} · ${(p.themes||"mixed").replaceAll(" "," · ")}`;
  $("#puzzleTurn").textContent=base.turn()==="w"?"White to move":"Black to move";
  renderPuzzleSolution();
  renderPuzzleHistory();
  updatePuzzleProgress();
  updatePuzzleNavigation();
  scheduleAutoAnalysis();
}

function setPuzzlePosition(index){
  if(!puzzleState?.timeline?.length)return;
  const max=puzzleState.timeline.length-1;
  index=Math.max(0,Math.min(max,index));
  const entry=puzzleState.timeline[index];
  const node=historyNode(entry.nodeId);
  if(node){
    jumpToHistoryNode(node.id);
    return;
  }

  const g=new Chess();
  try{g.load(entry.fen)}catch{return}
  puzzleState.chess=g;
  puzzleState.viewIndex=index;
  selected=null;
  drawBoard("#puzzleBoard",g,puzzleFlipped,handlePuzzleSquare);
  updatePuzzleNavigation();
  resetEvaluation();
  scheduleAutoAnalysis();
}

function updatePuzzleNavigation(){
  const prev=$("#puzzlePrevMove"), next=$("#puzzleNextMove");
  if(!prev||!next||!puzzleState)return;
  const node=historyNode(puzzleState.currentNodeId);
  const parent=node?.parentId!==null?historyNode(node.parentId):null;
  const firstChild=node?.children?.length?historyNode(node.children[0]):null;

  prev.disabled=!parent;
  next.disabled=!firstChild;
  prev.title=parent?`Back to ${parent.san||"start"}`:"Beginning";
  next.title=firstChild?`Forward to ${firstChild.san}`:"Latest position";
}

function handlePuzzleSquare(sq){
  if(!puzzleState)return;
  const game=puzzleState.chess;
  const atLivePosition=puzzleState.viewIndex===puzzleState.timeline.length-1;

  // During an unsolved puzzle, historical positions are read-only.
  if(!puzzleState.solved && !atLivePosition){
    flash("Return to the latest position to continue the puzzle.");
    return;
  }

  // After solving, the board becomes a free analysis board.
  if(puzzleState.solved){
    if(!selected){
      const piece=game.get(sq);
      if(piece&&piece.color===game.turn()){
        selected=sq;
        drawBoard("#puzzleBoard",game,puzzleFlipped,handlePuzzleSquare,selected);
      }
      return;
    }

    const from=selected,to=sq;
    if(from===to){
      selected=null;
      drawBoard("#puzzleBoard",game,puzzleFlipped,handlePuzzleSquare);
      return;
    }

    try{
      const moved=game.move({from,to,promotion:"q"});
      if(!moved){
        selected=null;
        drawBoard("#puzzleBoard",game,puzzleFlipped,handlePuzzleSquare);
        return;
      }
      puzzleState.analysisMoves.push(moved.san);
      const analysisFrom=from, analysisTo=to;
      createHistoryNode(game.fen(),moved.san,true,puzzleState.currentNodeId);
      puzzleState.timeline.push({fen:game.fen(),san:moved.san,user:true,nodeId:puzzleState.currentNodeId});
      selected=null;
      renderPuzzleHistory();
      updatePuzzleNavigation();
      drawBoard("#puzzleBoard",game,puzzleFlipped,handlePuzzleSquare);
      renderCapturedPieces(game);
      animateBoardMove(analysisFrom,analysisTo);
      $("#puzzleTurn").textContent=game.turn()==="w"?"White to move":"Black to move";
      scheduleAutoAnalysis();
    }catch{
      selected=null;
      drawBoard("#puzzleBoard",game,puzzleFlipped,handlePuzzleSquare);
    }
    return;
  }

  if(!selected){
    const piece=game.get(sq);
    if(piece&&piece.color===game.turn()){
      selected=sq;
      drawBoard("#puzzleBoard",game,puzzleFlipped,handlePuzzleSquare,selected);
    }
    return;
  }

  const from=selected,to=sq;
  if(from===to){
    selected=null;
    drawBoard("#puzzleBoard",game,puzzleFlipped,handlePuzzleSquare);
    return;
  }

  const moves=parseLine(puzzleState.puzzle.moves);
  const expected=moves[puzzleState.step];
  if(!expected){selected=null;return}

  const moved=attemptMove(game,from,to,expected,()=>{finalizeCurrentPuzzleOutcome("wrong");flash("Not the puzzle move — calculate again.")});
  selected=null;

  if(!moved){
    drawBoard("#puzzleBoard",game,puzzleFlipped,handlePuzzleSquare);
    return;
  }

  puzzleState.userMoves.push({san:moved.san,user:true});
  puzzleState.step++;
  recordPuzzlePosition(moved.san,true,from,to);
  const userMoveFrom=from, userMoveTo=to;
  resetEvaluation();

  if(puzzleState.step>=moves.length){
    puzzleState.solved=true;
    if(puzzleCurrentOutcome!=="wrong" && puzzleCurrentOutcome!=="solution") finalizeCurrentPuzzleOutcome("correct");
    puzzleSessionSolved++;
    puzzleState.viewIndex=puzzleState.timeline.length-1;
    drawBoard("#puzzleBoard",game,puzzleFlipped,handlePuzzleSquare);
    animateBoardMove(userMoveFrom,userMoveTo);
    $("#puzzleTurn").textContent="Puzzle solved — analysis mode";
    updatePuzzleProgress();
    renderPuzzleHistory();
    updatePuzzleNavigation();
    scheduleAutoAnalysis();
    flash("Puzzle solved.");
    return;
  }

  const reply=moves[puzzleState.step];
  renderPuzzleHistory();
  drawBoard("#puzzleBoard",game,puzzleFlipped,handlePuzzleSquare);
  animateBoardMove(userMoveFrom,userMoveTo);
  $("#puzzleTurn").textContent="Opponent is thinking…";
  updatePuzzleNavigation();
  if(replyTimer)clearTimeout(replyTimer);
  replyTimer=setTimeout(()=>{
    if(!puzzleState)return;
    try{
      const replyMove=game.move({from:reply.slice(0,2),to:reply.slice(2,4),promotion:reply[4]||"q"});
      puzzleState.userMoves.push({san:replyMove?.san||reply,user:false});
      puzzleState.step++;
      recordPuzzlePosition(replyMove?.san||reply,false,reply.slice(0,2),reply.slice(2,4));
      drawBoard("#puzzleBoard",game,puzzleFlipped,handlePuzzleSquare);
      renderCapturedPieces(game);
      animateBoardMove(reply.slice(0,2),reply.slice(2,4));
      renderPuzzleHistory();
      $("#puzzleTurn").textContent=game.turn()==="w"?"White to move":"Black to move";
      updatePuzzleNavigation();
      scheduleAutoAnalysis();
    }catch(e){
      console.error("Puzzle reply error",reply,e);
      puzzleState.solved=true;
      $("#puzzleTurn").textContent="Position ready";
    }
    replyTimer=null;
  },650);
}

function applyPuzzleProfile(){
  const name=puzzleProfile.name||"Carneceria07", elo=puzzleProfile.elo||"1044", avatar=puzzleProfile.avatar||"assets/profile-avatar.svg";
  $$('[data-profile-name]').forEach(x=>x.textContent=name);
  $$('[data-profile-elo]').forEach(x=>x.textContent=`${elo} ELO`);
  $$('[data-profile-avatar]').forEach(x=>x.src=avatar);
}

function openProfileEditor(){
  const modal=$("#profileModal"); if(!modal)return;
  $("#profileNameInput").value=puzzleProfile.name||"";
  $("#profileEloInput").value=puzzleProfile.elo||"";
  $("#profilePhotoInput").value="";
  modal.hidden=false;
}
function closeProfileEditor(){const modal=$("#profileModal");if(modal)modal.hidden=true}

function bindProfileEditor(){
  $("#editProfile").onclick=openProfileEditor;
  $("#profileClose").onclick=closeProfileEditor;
  $("#profileCancel").onclick=closeProfileEditor;
  $("#profileSave").onclick=()=>{
    const name=$("#profileNameInput").value.trim();
    const elo=$("#profileEloInput").value.trim();
    if(!name||!elo){flash("Enter both a name and ELO.");return}
    puzzleProfile.name=name;puzzleProfile.elo=elo;
    const file=$("#profilePhotoInput").files?.[0];
    const finish=()=>{localStorage.setItem("chessAtlasPuzzleProfile",JSON.stringify(puzzleProfile));applyPuzzleProfile();closeProfileEditor();flash("Profile updated.")};
    if(file){const reader=new FileReader();reader.onload=()=>{puzzleProfile.avatar=reader.result;finish()};reader.readAsDataURL(file)}else finish();
  };
  $("#profileModal").addEventListener("click",e=>{if(e.target.id==="profileModal")closeProfileEditor()});
  applyPuzzleProfile();
}

function bindPuzzleSession(){
  $("#puzzleBack").onclick=()=>showView("puzzles");

  $("#puzzleFlip").onclick=()=>{
    puzzleFlipped=!puzzleFlipped;
    if(puzzleState)drawBoard("#puzzleBoard",puzzleState.chess,puzzleFlipped,handlePuzzleSquare);
  };

  $("#skipPuzzle").onclick=()=>{
    if(puzzleState){
      advancePuzzleSession();
    }
  };

  $("#nextPuzzle").onclick=()=>{
    if(puzzleState){
      advancePuzzleSession();
    }
  };

  $("#puzzlePrevMove").onclick=()=>{
    if(!puzzleState)return;
    const node=historyNode(puzzleState.currentNodeId);
    if(node?.parentId!==null)jumpToHistoryNode(node.parentId);
  };

  $("#puzzleNextMove").onclick=()=>{
    if(!puzzleState)return;
    const node=historyNode(puzzleState.currentNodeId);
    if(node?.children?.length)jumpToHistoryNode(node.children[0]);
  };

  $("#revealSolution").onclick=()=>{
    if(!puzzleState)return;
    puzzleState.solutionRevealed=!puzzleState.solutionRevealed;
    if(puzzleState.solutionRevealed){finalizeCurrentPuzzleOutcome("solution")}
    renderPuzzleSolution();
  };
}

function flash(t){const x=$("#toast");x.textContent=t;x.classList.add("show");clearTimeout(window._toast);window._toast=setTimeout(()=>x.classList.remove("show"),1900)}

// Stockfish analysis
let engineEnabled=localStorage.getItem("chessAtlas.engineEnabled")!=="0";
let autoAnalysisEnabled=localStorage.getItem("chessAtlas.autoAnalysis")!=="0";
let evalBarEnabled=localStorage.getItem("chessAtlas.evalBar")!=="0";
let analysisRunId=0;
let autoAnalysisTimer=null;
let analysisController=null;

function resetEvaluation(){
  const fill=$("#evaluationFill"), text=$("#evaluationText");
  if(fill)fill.style.height="50%";
  if(text)text.textContent="—";
}

function setEvaluation(score){
  const fill=$("#evaluationFill"), text=$("#evaluationText");
  if(!fill||!text)return;
  if(!score){resetEvaluation();return}
  if(score.type==="mate"){
    text.textContent=`M${Math.abs(score.value)}`;
    fill.style.height=score.value>0?"0%":"100%";
    return;
  }
  const cp=score.value/100;
  const clamped=Math.max(-10,Math.min(10,cp));
  const whitePct=50+(clamped/20)*100;
  fill.style.height=`${100-whitePct}%`;
  text.textContent=`${cp>=0?"+":""}${cp.toFixed(2)}`;
}

function uciToSanLine(fen,pv){
  const g=new Chess();
  try{g.load(fen)}catch{return pv||[]}
  return (pv||[]).map(u=>{
    try{
      const m=g.move({from:u.slice(0,2),to:u.slice(2,4),promotion:u[4]||"q"});
      return m?m.san:u;
    }catch{return u}
  });
}

function formatEngineScore(score){
  if(!score)return "—";
  if(score.type==="mate")return `Mate in ${Math.abs(score.value)}`;
  const cp=score.value/100;
  return `${cp>=0?"+":""}${cp.toFixed(2)}`;
}

function renderAnalysisResult(d,fen){
  const out=$("#analysisResult");
  if(!out)return;
  const score=formatEngineScore(d.score);
  const pv=uciToSanLine(fen,d.pv||[]);
  const side=fen.split(" ")[1]==="w"?"White":"Black";
  const verdict=d.score?.type==="mate"
    ? `${d.score.value>0?"White":"Black"} has a forced mate.`
    : d.score
      ? `${Math.abs(d.score.value)<20?"Roughly equal.":d.score.value>0?"White is better.":"Black is better."}`
      : "No evaluation returned.";

  out.innerHTML=`
    <div class="analysis-summary">
      <div class="eval-readout"><strong>${score}</strong><span>${verdict}</span></div>
      <div class="best-readout"><span>BEST MOVE</span><b>${pv[0]||d.bestmove||"—"}</b></div>
      <div class="depth-readout"><span>DEPTH</span><b>${d.depth||"—"}</b></div>
    </div>
    <div class="pv-label">Principal variation</div>
    <div class="pv-line">${pv.length?pv.map((m,i)=>`<span>${i+1}. ${m}</span>`).join(""):"—"}</div>
    <div class="analysis-foot">Evaluation from White's perspective · ${side} to move</div>`;
}

async function analyzeCurrentPosition(silent=false){
  const btn=$("#analyzePosition"), out=$("#analysisResult");
  const game=puzzleState?.chess;
  if(!btn||!out)return;

  if(!engineEnabled){
    out.innerHTML=`<div class="analysis-disabled">Engine analysis is turned off. Turn Engine ON to analyze this position.</div>`;
    $("#engineStatus").textContent="Engine off";
    return;
  }
  if(!game){
    out.innerHTML=`<div class="analysis-error">No puzzle position is loaded.</div>`;
    return;
  }

  if(analysisController)analysisController.abort();
  analysisController=new AbortController();
  const run=++analysisRunId;
  const isManual=!silent;

  btn.disabled=false;
  if(isManual)btn.textContent="Analyzing…";
  $("#engineStatus").textContent="Calculating…";
  if(isManual||autoAnalysisEnabled){
    out.innerHTML=`<div class="analysis-thinking">Stockfish is calculating the current position…</div>`;
  }

  const fen=game.fen();
  try{
    const d=await localEngineAnalyze(fen,{depth:isManual?18:12});
    if(run!==analysisRunId)return;
    if(!silent)renderAnalysisResult(d,fen);
    setEvaluation(d.score);
    $("#engineStatus").textContent=silent?"Eval updated":"Analysis ready";
  }catch(e){
    if(e.name==="AbortError")return;
    if(run!==analysisRunId)return;
    console.error("Stockfish analysis failed:",e);
    out.innerHTML=`<div class="analysis-error">Analysis failed: ${e.message}</div>`;
    $("#engineStatus").textContent="Engine unavailable";
    resetEvaluation();
  }finally{
    if(run===analysisRunId){
      btn.disabled=false;
      btn.textContent="Analyze position";
    }
  }
}


function scheduleAutoAnalysis(){
  clearTimeout(autoAnalysisTimer);
  if(!engineEnabled||(!autoAnalysisEnabled&&!evalBarEnabled)||!puzzleState)return;
  autoAnalysisTimer=setTimeout(()=>analyzeCurrentPosition(!autoAnalysisEnabled),250);
}

function updateAnalysisControls(){
  const engine=$("#engineToggle"), auto=$("#autoAnalysisToggle"), eval=$("#evalToggle"), panel=$("#analysisPanel"), bar=$("#evaluationBar");
  if(engine){
    engine.classList.toggle("active",engineEnabled);
    engine.innerHTML=`Engine <b>${engineEnabled?"ON":"OFF"}</b>`;
  }
  if(auto){
    auto.classList.toggle("active",autoAnalysisEnabled);
    auto.disabled=!engineEnabled;
    auto.innerHTML=`Auto <b>${autoAnalysisEnabled?"ON":"OFF"}</b>`;
  }
  if(eval){
    eval.classList.toggle("active",evalBarEnabled);
    eval.innerHTML=`Eval bar <b>${evalBarEnabled?"ON":"OFF"}</b>`;
  }
  if(panel)panel.classList.toggle("engine-off",!engineEnabled);
  if(bar)bar.hidden=!evalBarEnabled||!engineEnabled;
  if(!engineEnabled){
    analysisRunId++;
    if(analysisController)analysisController.abort();
    clearTimeout(autoAnalysisTimer);
    if($("#engineStatus"))$("#engineStatus").textContent="Engine off";
    if($("#analysisResult"))$("#analysisResult").innerHTML=`<div class="analysis-disabled">Engine analysis is turned off.</div>`;
    resetEvaluation();
  }
}

const engineButton=$("#engineToggle");
if(engineButton)engineButton.onclick=()=>{
  engineEnabled=!engineEnabled;
  localStorage.setItem("chessAtlas.engineEnabled",engineEnabled?"1":"0");
  updateAnalysisControls();
  if(engineEnabled&&(autoAnalysisEnabled||evalBarEnabled))scheduleAutoAnalysis();
};

const autoButton=$("#autoAnalysisToggle");
if(autoButton)autoButton.onclick=()=>{
  if(!engineEnabled)return;
  autoAnalysisEnabled=!autoAnalysisEnabled;
  localStorage.setItem("chessAtlas.autoAnalysis",autoAnalysisEnabled?"1":"0");
  updateAnalysisControls();
  if(autoAnalysisEnabled||evalBarEnabled)scheduleAutoAnalysis();
};

const evalButton=$("#evalToggle");
if(evalButton)evalButton.onclick=()=>{
  evalBarEnabled=!evalBarEnabled;
  localStorage.setItem("chessAtlas.evalBar",evalBarEnabled?"1":"0");
  updateAnalysisControls();
};

const analysisButton=$("#analyzePosition");
if(analysisButton)analysisButton.onclick=analyzeCurrentPosition;

updateAnalysisControls();

// ---------------------------------------------------------------------------
// Game Review: pull real games from Chess.com and let Stockfish find blunders.
// ---------------------------------------------------------------------------
let grUsername="", grGames=[], grActiveGame=null, grMoves=[], grFens=[], grEvals=[];
let grPointer=0, grFlipped=false, grBoardChess=new Chess();
const grAnalysisCache={}; // url -> {moves,fens,evals}

function bindGameReview(){
  $("#loadGames").onclick=grLoadGames;
  $("#chesscomUsername").onkeydown=e=>{if(e.key==="Enter")grLoadGames()};
  $("#grBack").onclick=()=>{
    $("#gameAnalysisWrap").hidden=true;
    $("#gamesListWrap").hidden=false;
  };
  $("#grPrev").onclick=()=>grJumpTo(grPointer-1);
  $("#grNext").onclick=()=>grJumpTo(grPointer+1);
  $("#grFlip").onclick=()=>{grFlipped=!grFlipped;drawBoard("#reviewBoard",grBoardChess,grFlipped,()=>{})};
  $("#analyzeAllGames").onclick=grAnalyzeAll;
}

async function grLoadChessComArchive(username,count){
  const ar=await fetch(`https://api.chess.com/pub/player/${encodeURIComponent(username)}/games/archives`);
  if(!ar.ok)throw new Error(`Chess.com API returned ${ar.status}`);
  const months=(await ar.json()).archives||[];
  const games=[];
  for(let mi=months.length-1;mi>=0&&games.length<count;mi--){
    const r=await fetch(months[mi]);
    if(!r.ok)continue;
    const text=await r.text();
    const chunks=text.split(/\n(?=\[Event )/).filter(Boolean);
    for(const pgn of chunks.reverse()){
      const headers={};
      for(const line of pgn.split(/\r?\n/)){
        const m=line.match(/^\[([A-Za-z0-9_]+)\s+"(.*)"\]$/);
        if(m)headers[m[1]]=m[2];
      }
      const white=headers.White||"",black=headers.Black||"";
      const isWhite=white.toLowerCase()===username.toLowerCase();
      const myColor=isWhite?"white":"black";
      const opponent=isWhite?black:white;
      const result=(headers.Result==="1-0"&&isWhite)||(headers.Result==="0-1"&&!isWhite)?"win":headers.Result==="1/2-1/2"?"draw":"loss";
      games.push({
        url:`chesscom:${headers.EndTime||headers.StartTime||games.length}:${games.length}`,
        pgn:pgn,opponent,opponent_rating:isWhite?(headers.BlackElo||"?"):(headers.WhiteElo||"?"),
        my_rating:isWhite?(headers.WhiteElo||"?"):(headers.BlackElo||"?"),
        my_color:myColor,result,time_class:headers.TimeClass||headers.TimeControl||"?",
        end_time:Date.parse((headers.EndDate||"")+"T"+(headers.EndTime||"00:00:00")+"Z")/1000
      });
      if(games.length>=count)break;
    }
  }
  return games.slice(0,count);
}
async function grLoadGames(){
  const input=$("#chesscomUsername").value.trim();
  const status=$("#grStatus");
  if(!input){flash("Enter a chess.com username first.");return}
  grUsername=input;
  const count=Number($("#chesscomCount").value)||10;
  status.textContent="Contacting chess.com directly from your browser…";
  $("#gamesListWrap").hidden=true;$("#aggregateReport").hidden=true;
  try{
    grGames=await grLoadChessComArchive(grUsername,count);
    if(!grGames.length){status.textContent=`No games found for "${grUsername}".`;return}
    status.textContent=`Loaded ${grGames.length} recent games for ${grUsername}. Select a game to review it with local Stockfish.`;
    $("#gamesListTitle").textContent=`${grGames.length} recent games — ${grUsername}`;
    renderGamesList();$("#gamesListWrap").hidden=false;
  }catch(e){
    status.textContent=`Couldn't load games: ${e.message}. Chess.com must be reachable from this browser.`;
  }
}
function grResultBadge(g){
  if(g.result==="win")return `<span class="badge win">Win</span>`;
  if(g.result==="loss")return `<span class="badge loss">Loss</span>`;
  return `<span class="badge draw">Draw</span>`;
}

function renderGamesList(){
  $("#gamesList").innerHTML=grGames.map((g,i)=>{
    const date=g.end_time?new Date(g.end_time*1000).toLocaleDateString():"—";
    const color=g.my_color==="white"?"White":"Black";
    return `<div class="review-item gr-game-card" data-i="${i}">
      <div>${grResultBadge(g)} <b>vs ${g.opponent||"?"}</b> <span class="muted">(${g.opponent_rating||"?"})</span></div>
      <div class="muted">${color} · ${g.time_class||"?"} · ${date}</div>
      <button class="secondary small" data-analyze="${i}">Analyze →</button>
    </div>`;
  }).join("");
  $$(".gr-game-card").forEach(c=>{
    c.querySelector("[data-analyze]").onclick=()=>grOpenGame(+c.dataset.i);
  });
}

async function grOpenGame(i){
  const g=grGames[i];
  grActiveGame=g;
  $("#gamesListWrap").hidden=true;
  $("#aggregateReport").hidden=true;
  $("#gameAnalysisWrap").hidden=false;
  $("#grGameMeta").textContent=`${grUsername} (${g.my_color}, ${g.my_rating||"?"}) vs ${g.opponent} (${g.opponent_rating||"?"}) · ${g.time_class||""} · ${g.result.toUpperCase()}`;
  $("#grExplainTitle").textContent="Analyzing…";
  $("#grExplainText").textContent="Stockfish is walking through this game move by move. This can take a little while on longer games.";
  $("#grMoveList").innerHTML="";
  $("#grSummary").innerHTML="";
  $("#grProgress").style.width="0%";
  grFlipped=g.my_color==="black";

  const cached=grAnalysisCache[g.url];
  if(cached){
    grMoves=cached.moves;grFens=cached.fens;grEvals=cached.evals;
    grRenderMoveList(); grRenderSummary(); grJumpTo(grFens.length-1);
    return;
  }

  const parsed=grParsePgn(g.pgn);
  if(!parsed){
    $("#grExplainTitle").textContent="Couldn't read this game";
    $("#grExplainText").textContent="The PGN for this game looks malformed or uses a variant chess.js can't parse.";
    return;
  }
  grMoves=parsed;
  try{
    await grRunAnalysis();
    grAnalysisCache[g.url]={moves:grMoves,fens:grFens,evals:grEvals};
    grRenderMoveList(); grRenderSummary(); grJumpTo(grFens.length-1);
  }catch(e){
    $("#grExplainTitle").textContent="Stockfish isn't available";
    $("#grExplainText").textContent=`${e.message}. Install Stockfish and make sure server.py can find it (see the README notes), then try again.`;
  }
}

function grParsePgn(pgn){
  const g=new Chess();
  if(!pgn||!g.load_pgn(pgn,{sloppy:true}))return null;
  return g.history({verbose:true});
}

async function grEngineEval(fen,depth){
  return localEngineAnalyze(fen,{depth});
}

function grWhiteVal(score){
  if(!score)return 0;
  if(score.type==="mate")return score.value>0?(100000-Math.abs(score.value)):(-100000+Math.abs(score.value));
  return score.value;
}

function grClassify(cpLoss){
  if(cpLoss>=250)return{label:"Blunder",cls:"blunder"};
  if(cpLoss>=120)return{label:"Mistake",cls:"mistake"};
  if(cpLoss>=50)return{label:"Inaccuracy",cls:"inaccuracy"};
  if(cpLoss>=15)return{label:"Good",cls:"good"};
  return{label:"Best",cls:"best"};
}

async function grRunAnalysis(depth=12){
  const replay=new Chess();
  grFens=[replay.fen()];
  grEvals=[await grEngineEval(replay.fen(),depth)];
  for(let i=0;i<grMoves.length;i++){
    replay.move(grMoves[i].san);
    grFens.push(replay.fen());
    grEvals.push(await grEngineEval(replay.fen(),depth));
    $("#grProgress").style.width=`${Math.round(((i+1)/grMoves.length)*100)}%`;
  }
}

function grMoveInfo(i){
  const mover=grMoves[i].color;
  const sign=mover==="w"?1:-1;
  const before=grWhiteVal(grEvals[i].score), after=grWhiteVal(grEvals[i+1].score);
  const cpLoss=Math.max(0,Math.round(sign*before-sign*after));
  const best=uciToSanLine(grFens[i],[grEvals[i].bestmove])[0]||grEvals[i].bestmove;
  const c=grClassify(cpLoss);
  return{ply:i,san:grMoves[i].san,mover,moveNumber:Math.floor(i/2)+1,cpLoss,best,...c,
    evalBefore:grEvals[i].score,evalAfter:grEvals[i+1].score};
}

function grRenderMoveList(){
  const rows=[];
  for(let i=0;i<grMoves.length;i++){
    if(i%2===0)rows.push(`<div class="gr-movenum">${Math.floor(i/2)+1}.</div>`);
    const info=grMoveInfo(i);
    const mine=grActiveGame&&info.mover===(grActiveGame.my_color==="white"?"w":"b");
    rows.push(`<button class="gr-move ${info.cls}${mine?" mine":""}" data-ply="${i}" title="${info.label}">${info.san}</button>`);
  }
  $("#grMoveList").innerHTML=rows.join("");
  $$(".gr-move").forEach(b=>b.onclick=()=>grJumpTo(+b.dataset.ply+1));
}

function grRenderSummary(){
  const myColor=grActiveGame.my_color==="white"?"w":"b";
  const mine=[];
  for(let i=0;i<grMoves.length;i++)if(grMoves[i].color===myColor)mine.push(grMoveInfo(i));
  const count=cls=>mine.filter(m=>m.cls===cls).length;
  const totalLoss=mine.reduce((a,m)=>a+m.cpLoss,0);
  const avgLoss=mine.length?totalLoss/mine.length:0;
  const accuracy=Math.max(0,Math.min(100,100-Math.min(60,avgLoss/8)));
  $("#grSummary").innerHTML=`
    <div class="side-label">YOUR MOVE QUALITY</div>
    <div class="side-stat"><strong>${accuracy.toFixed(0)}%</strong><span>approx. accuracy</span></div>
    <div class="gr-tally">
      <div class="gr-tally-row blunder"><span>Blunders</span><b>${count("blunder")}</b></div>
      <div class="gr-tally-row mistake"><span>Mistakes</span><b>${count("mistake")}</b></div>
      <div class="gr-tally-row inaccuracy"><span>Inaccuracies</span><b>${count("inaccuracy")}</b></div>
      <div class="gr-tally-row good"><span>Good / Best</span><b>${count("good")+count("best")}</b></div>
    </div>
    <div class="muted" style="margin-top:8px">Click any move on the right to see the board and what Stockfish would have played instead.</div>`;
}

function grExplain(i){
  if(i<0){
    $("#grExplainTitle").textContent="Starting position";
    $("#grExplainText").textContent="Use Next → to step through the game, or click any move on the right.";
    return;
  }
  const info=grMoveInfo(i);
  const mine=grActiveGame&&info.mover===(grActiveGame.my_color==="white"?"w":"b");
  const who=mine?"You":(grActiveGame.opponent||"Opponent");
  $("#grExplainTitle").textContent=`${info.moveNumber}${info.mover==="w"?".":"…"} ${info.san} — ${info.label}`;
  if(info.cls==="best"||info.cls==="good"){
    $("#grExplainText").textContent=`${who} played ${info.san}, close to Stockfish's top choice. Evaluation barely moved (about ${(info.cpLoss/100).toFixed(2)} pawns).`;
  }else{
    const mateNote=info.evalAfter&&info.evalAfter.type==="mate"?" This lets the opponent force mate." : "";
    $("#grExplainText").textContent=`${who} played ${info.san}, giving up roughly ${(info.cpLoss/100).toFixed(1)} pawns of evaluation.${mateNote} Stockfish preferred ${info.best} instead.`;
  }
}

function grJumpTo(idx){
  grPointer=Math.max(0,Math.min(grFens.length-1,idx));
  grBoardChess.load(grFens[grPointer]);
  drawBoard("#reviewBoard",grBoardChess,grFlipped,()=>{});
  $("#grMoveLabel").textContent=`Position ${grPointer} / ${grFens.length-1}`;
  $$(".gr-move").forEach(b=>b.classList.toggle("current",+b.dataset.ply===grPointer-1));
  grExplain(grPointer-1);
}

async function grAnalyzeAll(){
  const status=$("#grStatus");
  const btn=$("#analyzeAllGames");
  btn.disabled=true;
  const results=[];
  for(let gi=0;gi<Math.min(grGames.length,15);gi++){
    const g=grGames[gi];
    status.textContent=`Scanning game ${gi+1} of ${Math.min(grGames.length,15)} (${g.opponent})…`;
    const parsed=grParsePgn(g.pgn);
    if(!parsed)continue;
    try{
      const replay=new Chess();
      let fens=[replay.fen()], evals=[await grEngineEval(replay.fen(),10)];
      for(const mv of parsed){
        replay.move(mv.san);
        fens.push(replay.fen());
        evals.push(await grEngineEval(replay.fen(),10));
      }
      const myColor=g.my_color==="white"?"w":"b";
      for(let i=0;i<parsed.length;i++){
        if(parsed[i].color!==myColor)continue;
        const sign=myColor==="w"?1:-1;
        const cpLoss=Math.max(0,Math.round(sign*grWhiteVal(evals[i].score)-sign*grWhiteVal(evals[i+1].score)));
        const phase=i<20?"opening":i<60?"middlegame":"endgame";
        const c=grClassify(cpLoss);
        results.push({game:g,ply:i,san:parsed[i].san,cpLoss,cls:c.cls,phase});
      }
    }catch(e){
      status.textContent=`Stockfish isn't available: ${e.message}`;
      btn.disabled=false;
      return;
    }
  }
  btn.disabled=false;
  grRenderAggregate(results);
}

function grRenderAggregate(results){
  const blunders=results.filter(r=>r.cls==="blunder");
  const mistakes=results.filter(r=>r.cls==="mistake");
  const byPhase=p=>results.filter(r=>r.phase===p&&r.cls==="blunder").length;
  const phaseAll=p=>results.filter(r=>r.phase===p).length;
  const worst=[...results].sort((a,b)=>b.cpLoss-a.cpLoss).slice(0,5);
  const phases=["opening","middlegame","endgame"].map(p=>({name:p,blunders:byPhase(p),all:phaseAll(p)}));
  const priority=[...phases].sort((a,b)=>b.blunders-a.blunders || b.all-a.all)[0];
  $("#aggregateReport").hidden=false;
  $("#aggregateReport").innerHTML=`
    <div class="subsection-head aggregate-report-head"><div><span class="eyebrow">PATTERN REPORT</span><h3>What your games are telling you</h3></div><span class="status-line">${Math.min(grGames.length,15)} games scanned</span></div>
    <div class="aggregate-hero"><div><span>BIGGEST TRAINING PRIORITY</span><strong>${priority.name}</strong><p>${priority.blunders?`You had ${priority.blunders} blunder${priority.blunders===1?'':'s'} in this phase. Start there before adding more theory.`:'No blunders were detected in this phase. Keep it as a strength and work on the next highest-impact area.'}</p></div><div class="priority-score"><b>${priority.blunders}</b><span>blunders</span></div></div>
    <div class="phase-grid">
      ${phases.map(p=>`<div class="phase-card"><div><span>${p.name}</span><b>${p.blunders}</b></div><p>${p.blunders===0?'No blunders detected':'blunder'+(p.blunders===1?'':'s')} · ${p.all} analysed moves</p><div class="progress"><i style="width:${p.all?Math.min(100,p.blunders/p.all*100):0}%"></i></div></div>`).join('')}
    </div>
    <div class="scan-totals"><div><b>${blunders.length}</b><span>Blunders</span><small>≥2.5 pawns</small></div><div><b>${mistakes.length}</b><span>Mistakes</span><small>1.2–2.5 pawns</small></div><div><b>${results.filter(r=>r.cls==='inaccuracy').length}</b><span>Inaccuracies</span><small>0.5–1.2 pawns</small></div></div>
    <div class="subsection-head"><div><span class="eyebrow">WORST MOMENTS</span><h3>Start with these</h3></div></div>
    <div class="review-list aggregate-worst">
      ${worst.map(r=>`<div class="review-item"><div class="review-item-main"><span class="review-dot"></span><div><b>${r.san} · ${r.game.opponent}</b><strong>${r.phase} · −${(r.cpLoss/100).toFixed(1)} pawns</strong><span>Open the game to see the board, the engine’s alternative, and the position before the mistake.</span></div></div><button class="secondary small" data-worst-url="${r.game.url}">Open game →</button></div>`).join('') || `<div class="empty">No analysed moves were returned.</div>`}
    </div>`;
  $$('[data-worst-url]').forEach(b=>b.onclick=()=>{const g=grGames.find(x=>x.url===b.dataset.worstUrl);if(g)grOpenGame(grGames.indexOf(g));});
}

/* =================================================================
   BLINDFOLD MODE — text-only play + mistake archive
   ================================================================= */
let bfGame=null,bfConfig=null,bfStrikes=0,bfPeekUsed=false,bfStartedAt=null,bfEvents=[],bfPlyLog=[];
let bfArchiveGames=[];
let bfArchiveLoaded=false;
const BF_LEGACY_KEY="chessAtlasBlindfoldGames";
function bfGames(){return bfArchiveGames}
function updateBFBadge(){const e=$("#blindfoldBadge");if(e)e.textContent=bfArchiveGames.length}
async function loadBFGames(){
  try{bfArchiveGames=JSON.parse(localStorage.getItem(BF_LEGACY_KEY)||"[]");if(!Array.isArray(bfArchiveGames))bfArchiveGames=[]}
  catch{bfArchiveGames=[]}
  bfArchiveLoaded=true;updateBFBadge();
}
async function saveBFGame(game){
  bfArchiveGames.push(game);
  try{localStorage.setItem(BF_LEGACY_KEY,JSON.stringify(bfArchiveGames));updateBFBadge();return true}
  catch(e){bfArchiveGames.pop();bfSetFeedback("Browser storage is full. Export your archive and delete older games.","bad");return false}
}
async function deleteBFGames(ids){
  if(!ids.length)return true;
  bfArchiveGames=bfArchiveGames.filter(g=>!ids.includes(g.id));
  localStorage.setItem(BF_LEGACY_KEY,JSON.stringify(bfArchiveGames));updateBFBadge();return true;
}
async function clearBFGames(){
  bfArchiveGames=[];localStorage.removeItem(BF_LEGACY_KEY);updateBFBadge();return true;
}
function bfExportArchive(){
  const blob=new Blob([JSON.stringify({version:1,exportedAt:new Date().toISOString(),games:bfArchiveGames},null,2)],{type:"application/json"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`chess-atlas-blindfold-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
function bfImportArchive(file){
  if(!file)return;
  const reader=new FileReader();
  reader.onload=()=>{
    try{
      const parsed=JSON.parse(reader.result);
      const incoming=Array.isArray(parsed)?parsed:parsed.games;
      if(!Array.isArray(incoming))throw new Error("No games found");
      const existing=new Map(bfArchiveGames.map(g=>[g.id,g]));
      incoming.forEach(g=>{if(g&&g.id)existing.set(g.id,g)});
      bfArchiveGames=[...existing.values()].sort((a,b)=>String(a.startedAt||"").localeCompare(String(b.startedAt||"")));
      localStorage.setItem(BF_LEGACY_KEY,JSON.stringify(bfArchiveGames));updateBFBadge();renderBFArchive();
      flash(`Imported ${incoming.length} game${incoming.length===1?"":"s"}.`);
    }catch(e){flash(`Import failed: ${e.message}`)}
  };
  reader.readAsText(file);
}

function bfSanFor(game,input){
  const copy=new Chess(); copy.load(game.fen());
  try{const m=copy.move(input.trim(),{sloppy:true});return m?m.san:null}catch{return null}
}
function bfNormalize(s){return (s||"").replace(/[+#?!]+$/g,"").replace(/0-0-0/g,"O-O-O").replace(/0-0/g,"O-O").trim()}
function bfMoveExistsByInput(game,input){
  const san=bfSanFor(game,input); if(!san)return {legal:false};
  return {legal:true,san,exact:bfNormalize(san)===bfNormalize(input)};
}
function bfLogEvent(type,data={}){bfEvents.push({time:new Date().toISOString(),type,...data})}
function bfRenderHistory(){
  const el=$("#bfMoveHistory");if(!el)return;
  if(!bfPlyLog.length){el.innerHTML='<span class="bf-empty">Your moves will appear here after you play them.</span>';return}
  el.innerHTML=bfPlyLog.map((m,i)=>{const note=m.notationMistake?` · NOTE: ${m.san}`:'';return `<span class="bf-move-chip ${m.side===bfConfig.color?'you':'reply'} ${m.error?'error':''} ${m.notationMistake?'notation':''}">${Math.floor(i/2)+1}${i%2===0?'.':'…'} ${m.input||m.san}${m.error?' · '+m.error:''}${note}</span>`}).join('');
  const c=$("#bfMoveCount");if(c)c.textContent=`${bfPlyLog.length} plies`;
}
function bfSetFeedback(text,kind=""){const e=$("#bfFeedback");if(e){e.className="bf-feedback "+kind;e.textContent=text}}
function bfUpdateState(){
  if(!bfGame)return;
  const yourTurn=bfGame.turn()===bfConfig.color;
  $("#bfTurnLabel").textContent=yourTurn?"YOUR TURN":"OPPONENT THINKING";
  $("#bfTurnText").textContent=yourTurn?`${bfConfig.color==='w'?'White':'Black'} to move`:`${bfConfig.color==='w'?'Black':'White'} to move`;
  $("#bfTurnDot").style.background=yourTurn?"var(--gold)":"var(--teal)";
  $("#bfStrikeCount").textContent=`${bfStrikes} / 3`;
}
async function bfEngineReply(){
  if(!bfGame||bfGame.game_over()||bfGame.turn()===bfConfig.color)return;
  $("#bfSubmit").disabled=true;bfSetFeedback("Your opponent is calculating…");
  try{
    const d=await localEngineAnalyze(bfGame.fen(),{depth:10,elo:bfConfig.elo,limitStrength:true});
    if(!d.bestmove||d.bestmove==="0000")throw new Error("No legal engine move was returned");
    const beforeFen=bfGame.fen();
    const m=bfGame.move({from:d.bestmove.slice(0,2),to:d.bestmove.slice(2,4),promotion:d.bestmove[4]||"q"});
    if(!m)throw new Error("Engine returned an illegal move");
    bfPlyLog.push({side:m.color,san:m.san,input:m.san,kind:"reply",beforeFen:beforeFen,afterFen:bfGame.fen()});
    bfLogEvent("engine_move",{san:m.san,uci:d.bestmove,elo:bfConfig.elo});
    $("#bfLastMove").textContent=m.san;bfRenderHistory();bfUpdateState();
    if("speechSynthesis" in window && $("#bfVoiceToggle")?.checked) speechSynthesis.speak(new SpeechSynthesisUtterance(m.san));
    if(bfGame.game_over()){bfFinish(bfGame.in_checkmate()?"loss":"draw",bfGame.in_checkmate()?"Checkmate":"Game over");return}
    bfSetFeedback("Your turn.","good");
  }catch(e){bfSetFeedback(`Engine error: ${e.message}`,"bad");}
  finally{$("#bfSubmit").disabled=false;$("#bfMoveInput").focus();}
}
function bfStart(){
  bfConfig={color:$("#bfColor").value,elo:parseInt($("#bfElo").value,10)||1600,opening:$("#bfOpening").value};
  bfGame=new Chess();bfStrikes=0;bfPeekUsed=false;bfStartedAt=new Date().toISOString();bfEvents=[];bfPlyLog=[];
  bfLogEvent("game_start",{color:bfConfig.color,elo:bfConfig.elo});
  if(bfConfig.opening==="random"){
    const choices=bfGame.moves();const san=choices[Math.floor(Math.random()*choices.length)];const beforeFen=bfGame.fen();const m=bfGame.move(san);bfPlyLog.push({side:m.color,san:m.san,input:m.san,kind:"opening",beforeFen,afterFen:bfGame.fen()});bfLogEvent("forced_opening",{san:m.san});
  }
  $("#blindfoldSetup").hidden=true;$("#blindfoldGame").hidden=false;
  $("#bfGameMeta").textContent=`BLINDFOLD · ${bfConfig.elo} ELO`;
  $("#bfGameTitle").textContent=`You are ${bfConfig.color==='w'?'White':'Black'}`;
  $("#bfLastMove").textContent=bfPlyLog.length?bfPlyLog[bfPlyLog.length-1].san:"—";
  bfRenderHistory();bfUpdateState();bfSetFeedback("The board is in your head. Take your time.");
  $("#bfPeekCard").hidden=true;
  $("#bfPeek").disabled=true;
  $("#bfPeek").innerHTML="Sneak peek <span>1×</span>";
  showView("blindfold");$("#bfMoveInput").focus();
  if(bfGame.turn()!==bfConfig.color)bfEngineReply();
}
function bfHandleSubmit(){
  if(!bfGame||bfGame.game_over()||bfGame.turn()!==bfConfig.color)return;
  const input=$("#bfMoveInput").value.trim();if(!input)return;
  const result=bfMoveExistsByInput(bfGame,input);
  if(!result.legal){
    bfStrikes++;bfPeekUsed=false;bfLogEvent("illegal_move",{input,strike:bfStrikes,fen:bfGame.fen()});
    bfPlyLog.push({side:bfConfig.color,input,error:"FORGOTTEN",kind:"mistake",beforeFen:bfGame.fen(),afterFen:bfGame.fen(),strike:bfStrikes});bfRenderHistory();bfUpdateState();
    $("#bfMoveInput").value="";
    if(bfStrikes>=3){bfFinish("loss","Three illegal moves — automatic resignation.");return}
    $("#bfPeekCard").hidden=false;
    $("#bfPeek").disabled=false;
    $("#bfPeek").innerHTML="Sneak peek <span>1×</span>";
    bfSetFeedback(`Illegal move. ${3-bfStrikes} attempt${3-bfStrikes===1?'':'s'} remaining. This is logged as FORGOTTEN.`,"bad");
    return;
  }
  // Any legal move is played. If SAN differs only in notation (for example
  // Nf6 instead of Nf6+), warn the player but do NOT punish or stop the move.
  const notationMistake=!result.exact;
  const beforeFen=bfGame.fen();
  const m=bfGame.move(input,{sloppy:true});
  const afterFen=bfGame.fen();
  if(notationMistake){
    bfLogEvent("notation_error",{input,correct:result.san,fen:bfGame.fen()});
  }
  bfPlyLog.push({side:m.color,san:m.san,input,kind:"you",notationMistake,beforeFen,afterFen});
  bfLogEvent("player_move",{input,san:m.san,notationMistake});
  $("#bfLastMove").textContent=m.san;$("#bfMoveInput").value="";bfPeekUsed=false;$("#bfPeekCard").hidden=true;bfRenderHistory();bfUpdateState();
  if(notationMistake) bfSetFeedback(`Notation mistake: you wrote ${input}; the move is ${result.san}. The move was played and saved as a mistake.`,"warn");
  if(bfGame.game_over()){bfFinish(bfGame.in_checkmate()?"win":"draw",bfGame.in_checkmate()?"Checkmate — you win.":"Game over.");return}
  bfEngineReply();
}
async function bfFinish(result,reason){
  if(!bfGame)return;
  bfLogEvent("game_end",{result,reason});
  const gameRecord={id:Date.now(),startedAt:bfStartedAt,endedAt:new Date().toISOString(),color:bfConfig.color,elo:bfConfig.elo,result,reason,strikes:bfStrikes,peekUsed:bfPeekUsed,fen:bfGame.fen(),moves:bfPlyLog,events:bfEvents};
  const saved=await saveBFGame(gameRecord);
  if(!saved)return;
  $("#bfFeedback").textContent=reason;$("#bfFeedback").className="bf-feedback "+(result==="win"?"good":"bad");$("#bfSubmit").disabled=true;$("#bfPeekCard").hidden=true;
  setTimeout(()=>{if(confirm(`${reason}\n\nGame saved to Blindfold Archive. Start a new game?`)){$("#blindfoldSetup").hidden=false;$("#blindfoldGame").hidden=true;$("#bfSubmit").disabled=false;showView("blindfold")} },120);
}
function bfPeekBoard(){
  if(!bfGame||bfPeekUsed)return;
  bfPeekUsed=true;bfLogEvent("sneak_peek",{fen:bfGame.fen()});
  const wrap=document.createElement("div");wrap.className="bf-peek-overlay";wrap.innerHTML='<div class="bf-peek-dialog"><div class="section-label-row"><span>SNEAK PEEK</span><button class="profile-close" type="button">×</button></div><h3>One look. This position only.</h3><div id="bfPeekBoard" class="board bf-peek-board"></div><p>The peek is recorded in your game memory.</p></div>';
  document.body.appendChild(wrap);drawBoard("#bfPeekBoard",bfGame,false,()=>{});wrap.querySelector("button").onclick=()=>wrap.remove();
  $("#bfPeek").disabled=true;$("#bfPeek").textContent="Peek used";
}
function renderBFArchive(){
  const games=bfGames();updateBFBadge();const sum=$("#bfArchiveSummary"),list=$("#bfArchiveList"),detail=$("#bfArchiveDetail");if(detail)detail.hidden=true;
  if(sum)sum.innerHTML=`<div><strong>${games.length}</strong><span>games played</span></div><div><strong>${games.filter(g=>g.result==='win').length}</strong><span>wins</span></div><div><strong>${games.reduce((a,g)=>a+g.strikes,0)}</strong><span>illegal attempts</span></div><div><strong>${games.filter(g=>g.peekUsed).length}</strong><span>sneak peeks</span></div>`;
  if(!list)return;if(!games.length){list.innerHTML='<div class="empty-state"><b>No blindfold games yet.</b><p>Play a game and your full memory trail will appear here.</p></div>';return}
  list.innerHTML=`<div class="bf-archive-toolbar"><label class="bf-select-all"><input type="checkbox" id="bfSelectAll"><span>Select all visible games</span></label><button class="secondary small" id="bfDeleteSelected" disabled>Delete selected <span id="bfSelectedCount">0</span></button></div>` + games.map(g=>`<article class="bf-game-row"><label class="bf-game-select" title="Select this game"><input type="checkbox" class="bf-game-checkbox" data-bf-id="${g.id}"><span></span></label><div class="bf-game-date">${new Date(g.startedAt).toLocaleDateString()}</div><div class="bf-game-opponent"><strong>${g.color==='w'?'White':'Black'} vs ${g.elo} ELO</strong><span>${g.moves.length} plies · ${g.strikes} illegal attempt${g.strikes===1?'':'s'}${g.peekUsed?' · peek used':''}</span></div><div class="bf-game-result ${g.result}">${g.result.toUpperCase()}</div><button class="secondary small" data-bf-open="${g.id}">Review →</button></article>`).join('');
  const selectAll=$("#bfSelectAll"), deleteBtn=$("#bfDeleteSelected"), countEl=$("#bfSelectedCount");
  const boxes=[...list.querySelectorAll('.bf-game-checkbox')];
  const syncSelection=()=>{const selected=boxes.filter(x=>x.checked);if(countEl)countEl.textContent=selected.length;if(deleteBtn)deleteBtn.disabled=!selected.length;if(selectAll){selectAll.checked=boxes.length>0&&selected.length===boxes.length;selectAll.indeterminate=selected.length>0&&selected.length<boxes.length;}};
  boxes.forEach(x=>x.onchange=syncSelection);
  if(selectAll)selectAll.onchange=()=>{boxes.forEach(x=>x.checked=selectAll.checked);syncSelection()};
  if(deleteBtn)deleteBtn.onclick=async()=>{const ids=boxes.filter(x=>x.checked).map(x=>x.dataset.bfId);if(!ids.length)return;if(!confirm(`Delete ${ids.length} selected blindfold game${ids.length===1?'':'s'}? This cannot be undone.`))return;if(await deleteBFGames(ids))renderBFArchive()};
  list.querySelectorAll("[data-bf-open]").forEach(b=>b.onclick=()=>renderBFArchiveDetail(games.find(g=>g.id==b.dataset.bfOpen)));
}
function renderBFArchiveDetail(g){
  const d=$("#bfArchiveDetail"),list=$("#bfArchiveList");if(!g||!d)return;
  list.hidden=true;d.hidden=false;

  // Rebuild a trustworthy position timeline. Illegal attempts are events, not moves,
  // so they never advance the board. Older saved games without FEN snapshots are
  // reconstructed from their recorded SAN moves.
  const timeline=[];
  let replay=new Chess();
  let legalPly=0;
  for(let i=0;i<g.moves.length;i++){
    const m=g.moves[i];
    const before=m.beforeFen||replay.fen();
    let after=m.afterFen||before;
    if(!m.beforeFen||!m.afterFen){
      try{
        replay.load(before);
        if(!m.error&&m.san){replay.move(m.san);after=replay.fen();}
      }catch{after=before;}
    }
    timeline.push({index:i,beforeFen:before,afterFen:after,move:m,legalPly});
    if(!m.error)legalPly++;
    try{replay.load(after)}catch{}
  }
  const initialFen=timeline[0]?.beforeFen||new Chess().fen();

  const actual=timeline.filter(t=>!t.move.error);
  const illegal=timeline.filter(t=>t.move.error);
  const notation=timeline.filter(t=>t.move.notationMistake);
  const labelFor=(m)=>m.error?"FORGOTTEN":m.notationMistake?"NOTATION MISTAKE":(m.kind==="reply"?"ENGINE MOVE":"PLAYED");

  d.innerHTML=`
    <button class="back" id="bfArchiveBack">← All games</button>
    <div class="bf-review-header">
      <div>
        <span class="eyebrow">${new Date(g.startedAt).toLocaleString()} · ${g.elo} ELO</span>
        <h2>${g.result.toUpperCase()} · ${g.color==='w'?'White':'Black'}</h2>
        <p>${g.reason}</p>
      </div>
      <div class="bf-review-metrics">
        <div><b>${actual.length}</b><span>played plies</span></div>
        <div><b>${illegal.length}</b><span>forgotten</span></div>
        <div><b>${notation.length}</b><span>notation errors</span></div>
        <div><b>${g.peekUsed?'1':'0'}</b><span>sneak peeks</span></div>
      </div>
    </div>

    <div class="bf-review-layout">
      <div class="bf-review-main">
        <div class="bf-review-board-wrap">
          <div id="bfArchiveBoard" class="board bf-review-board"></div>
          <div class="bf-review-position-bar">
            <div><span id="bfArchivePositionLabel">Starting position</span><b id="bfArchivePositionSub">Before the first attempt</b></div>
            <span id="bfArchivePlyLabel">0 / ${timeline.length}</span>
          </div>
        </div>
        <div id="bfArchiveEvent" class="bf-review-event-card"></div>
      </div>

      <aside class="bf-review-sidebar">
        <div class="bf-review-card-head"><div><span class="eyebrow">GAME TIMELINE</span><h3>What you remembered</h3></div><span>${timeline.length} attempts</span></div>
        <div class="bf-review-timeline" id="bfReviewTimeline">
          <button class="bf-timeline-item active" data-bf-review="-1"><span class="bf-timeline-num">START</span><div><b>Starting position</b><small>No move has been attempted.</small></div></button>
          ${timeline.map(t=>{
            const m=t.move, side=m.side===g.color?'You':'Opponent';
            const moveLabel=m.error?`ATTEMPT ${t.index+1}`:`${Math.floor(t.legalPly/2)+1}${t.legalPly%2===0?'.':'…'}`;
            return `<button class="bf-timeline-item ${m.error?'is-error':''} ${m.notationMistake?'is-notation':''}" data-bf-review="${t.index}">
              <span class="bf-timeline-num">${moveLabel}</span>
              <div><b>${m.input||m.san||'—'}</b><small>${side} · ${labelFor(m)}${m.error?` · strike ${m.strike||'?'}`:''}${m.notationMistake?` · played ${m.san}`:''}</small></div>
            </button>`;
          }).join('')}
        </div>
      </aside>
    </div>

    <div class="bf-history-card bf-recorded-events">
      <div class="section-label-row"><span>RECORDED EVENTS</span><span>${g.events.length}</span></div>
      <div class="bf-event-list">
        ${g.events.map(e=>`<div class="bf-event"><b>${e.type.replaceAll('_',' ')}</b><span>${new Date(e.time).toLocaleTimeString()}</span>${e.input?`<strong>${e.input}</strong>`:''}${e.correct?`<em>→ ${e.correct}</em>`:''}</div>`).join('')}
      </div>
    </div>`;

  $("#bfArchiveBack").onclick=()=>{list.hidden=false;d.hidden=true};

  const drawAt=(idx)=>{
    let fen=initialFen, title="Starting position", sub="Before the first attempt";
    if(idx>=0){
      const t=timeline[idx];
      const m=t.move;
      fen=m.error?t.beforeFen:t.afterFen;
      title=`${Math.floor(idx/2)+1}${idx%2===0?'.':'…'} ${m.input||m.san||'—'}`;
      if(m.error)sub=`FORGOTTEN · strike ${m.strike||'—'} · position did not change`;
      else if(m.notationMistake)sub=`NOTATION MISTAKE · played as ${m.san}`;
      else sub=m.kind==='reply'?"Opponent's move":"Your move";
    }
    const board=new Chess();try{board.load(fen)}catch{}
    drawBoard("#bfArchiveBoard",board,g.color==='b',()=>{});
    $("#bfArchivePositionLabel").textContent=title;
    $("#bfArchivePositionSub").textContent=sub;
    $("#bfArchivePlyLabel").textContent=`${Math.max(0,idx+1)} / ${timeline.length}`;
    const t=idx>=0?timeline[idx]:null,m=t?.move;
    $("#bfArchiveEvent").innerHTML=t?`
      <div class="bf-event-kicker">${labelFor(m)}</div>
      <h3>${m.input||m.san||'—'}${m.notationMistake?` <span>→ ${m.san}</span>`:''}</h3>
      <p>${m.error?`You attempted <b>${m.input}</b>, but that move was illegal in the position. It was recorded as a forgotten move and counted as strike ${m.strike||'—'}. The board stayed unchanged.`:m.notationMistake?`The move itself was legal. You entered <b>${m.input}</b>, while the complete SAN is <b>${m.san}</b>. It was played normally and recorded as a notation mistake.`:m.kind==='reply'?`The engine replied <b>${m.san}</b>.`: `You played <b>${m.san}</b>.`}</p>`:`<div class="bf-event-kicker">STARTING POSITION</div><h3>Your blindfold memory begins here.</h3><p>Select an attempt from the timeline to reconstruct exactly what happened.</p>`;
    d.querySelectorAll('.bf-timeline-item').forEach(b=>b.classList.toggle('active',+b.dataset.bfReview===idx));
  };
  d.querySelectorAll('[data-bf-review]').forEach(b=>b.onclick=()=>drawAt(+b.dataset.bfReview));
  drawAt(-1);
}

function bindBlindfold(){
  const eloSlider=$("#bfElo"),eloValue=$("#bfEloValue");
  if(eloSlider&&eloValue){
    const sync=()=>{eloValue.value=eloSlider.value;eloValue.textContent=eloSlider.value;};
    eloSlider.addEventListener("input",sync);sync();
  }
  $("#bfStart").onclick=bfStart;
  $("#bfSubmit").onclick=bfHandleSubmit;
  $("#bfMoveInput").onkeydown=e=>{if(e.key==="Enter")bfHandleSubmit()};
  $("#bfBack").onclick=()=>{$("#blindfoldGame").hidden=true;$("#blindfoldSetup").hidden=false;showView("blindfold")};
  $("#bfPeek").onclick=bfPeekBoard;
  $("#bfResign").onclick=()=>{if(bfGame&&!bfGame.game_over()&&confirm("Resign and save this blindfold game?"))bfFinish("loss","You resigned the game.")};
  $("#bfClearArchive").onclick=async()=>{if(confirm("Delete all saved blindfold games from this browser?")){if(await clearBFGames())renderBFArchive()}};
  $("#bfExportArchive")?.addEventListener("click",bfExportArchive);
  $("#bfImportArchive")?.addEventListener("change",e=>bfImportArchive(e.target.files[0]));
  const n=$(".nav[data-view='blindfoldArchive']");if(n)n.onclick=async()=>{showView("blindfoldArchive");if(!bfArchiveLoaded)await loadBFGames();renderBFArchive()};
  const speakBtn=$("#bfSpeak");
  if(speakBtn){
    const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!SR){speakBtn.disabled=true;speakBtn.title="Speech recognition is not supported in this browser";}
    else{
      speakBtn.onclick=()=>{
        const rec=new SR();rec.lang="en-US";rec.interimResults=false;rec.maxAlternatives=1;
        speakBtn.textContent="Listening…";speakBtn.disabled=true;
        rec.onresult=e=>{const spoken=e.results[0][0].transcript.trim().replace(/\bcastle kingside\b/ig,"O-O").replace(/\bcastle queenside\b/ig,"O-O-O");$("#bfMoveInput").value=spoken.replace(/\s+/g,"");};
        rec.onerror=()=>{};
        rec.onend=()=>{speakBtn.textContent="Speak move";speakBtn.disabled=false;$("#bfMoveInput").focus();};
        rec.start();
      };
    }
  }
  loadBFGames();
}

// Hook the mode into the existing initializer without disturbing the other trainers.
const __originalInit=init;
init=async function(){await __originalInit();bindBlindfold();updateBFBadge()};

// Start only after the Blindfold hook has been installed.
init();
