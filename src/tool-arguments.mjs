// JSON.parse silently keeps the last duplicate key. Tool paths must never be ambiguous.
export function parseToolArguments(text) {
  const value=JSON.parse(text);
  if(!value||typeof value!=='object'||Array.isArray(value))throw new SyntaxError('tool_object_required');
  const tokens=text.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g)||[],stack=[];
  for(let i=0;i<tokens.length;i++){
    const token=tokens[i];
    if(token==='{')stack.push(new Set());
    else if(token==='[')stack.push(null);
    else if(token==='}'||token===']')stack.pop();
    else if(token.startsWith('"')&&tokens[i+1]===':'){
      const key=JSON.parse(token),keys=stack.at(-1);
      if(keys?.has(key))throw new SyntaxError('duplicate_tool_key');
      keys?.add(key);
    }
  }
  return value;
}
