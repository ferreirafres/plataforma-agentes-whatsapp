'use strict';
let stageFoldStates={};
try{const saved=JSON.parse(localStorage.getItem('agent-fold-states')||'{}');if(saved&&typeof saved==='object'&&!Array.isArray(saved))stageFoldStates=saved;}catch{}
function isStageCollapsed(id,place='card'){return stageFoldStates[place+':'+id]===true;}
function foldStage(button,id,place,body){
  const collapsed=button.getAttribute('aria-expanded')==='true';
  button.setAttribute('aria-expanded',String(!collapsed));
  body.hidden=collapsed;stageFoldStates[place+':'+id]=collapsed;
  try{localStorage.setItem('agent-fold-states',JSON.stringify(stageFoldStates));}catch{}
}
