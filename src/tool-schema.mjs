// Validate the small, host-owned JSON schemas exposed by the native tools.
// This is not a general JSON Schema implementation; unsupported keywords are
// not used by these tools. Never return caller-supplied values or unknown keys.
export function toolSchemaErrors(value,schema,path='$') {
 const errors=[];
 const walk=(item,rule,at)=>{
  if(errors.length>=32)return;
  const types=Array.isArray(rule.type)?rule.type:[rule.type];
  const matches=type=>type==='null'?item===null:type==='array'?Array.isArray(item):type==='object'?item!==null&&typeof item==='object'&&!Array.isArray(item):
   type==='integer'?Number.isSafeInteger(item):typeof item===type;
  if(rule.type&&!types.some(matches)){errors.push(`${at}:type`);return;}
  if(rule.enum&&!rule.enum.includes(item))errors.push(`${at}:enum`);
  if(rule.minimum!==undefined&&item<rule.minimum)errors.push(`${at}:minimum`);
  if(item!==null&&typeof item==='object'&&!Array.isArray(item)){
   for(const key of rule.required||[])if(!Object.hasOwn(item,key))errors.push(`${at}.${key}:required`);
   for(const [key,child]of Object.entries(item)){
    if(Object.hasOwn(rule.properties||{},key))walk(child,rule.properties[key],`${at}.${key}`);
    else if(rule.additionalProperties===false)errors.push(`${at}.<unknown>:additional_property`);
   }
  }
  if(Array.isArray(item)&&rule.items)for(let i=0;i<item.length&&errors.length<32;i++)walk(item[i],rule.items,`${at}[${i}]`);
 };
 walk(value,schema,path);return errors.slice(0,32);
}
