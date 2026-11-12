// Oracle: unmodified MIT upstream sources at v3.4.4, not the Go output.
// npx tsx go/internal/anthropicauth/testdata/gen-golden.ts [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as billing from "./upstream/src/billing-header.ts";
import * as versions from "./upstream/src/claude-code-version.ts";
import * as sections from "./upstream/src/system-prompt-sections.ts";
import * as shaping from "./upstream/src/system-prompt-shaping.ts";
import { shapeAnthropicOAuthPayload } from "./upstream/src/request-shaping.ts";
import { parseExtensionConfig } from "./upstream/src/extension-config.ts";
import { createBillingVersionSync } from "./upstream/src/billing-version-sync.ts";
import { createAnthropicOAuthStreamSimple } from "./upstream/src/oauth-transport.ts";
import { lookupProviderAccount } from "./upstream/src/account-profile.ts";
import { formatDiagnosticsReport, statusArgumentCompletions } from "./upstream/src/diagnostics.ts";
import { readClaudeCodeVersionRejection, describeRecoveryHint } from "./upstream/src/version-rejection.ts";

const here = dirname(fileURLToPath(import.meta.url));
// Check every vendored source/test byte before using it as an oracle.
const manifest = JSON.parse(readFileSync(join(here,"upstream-manifest.json"),"utf8"));
for (const [path, expected] of Object.entries(manifest.sha256)) {
 const actual = createHash("sha256").update(readFileSync(join(here,"upstream",path))).digest("hex");
 if(actual !== expected) throw new Error(`upstream snapshot drift: ${path}`);
}
delete process.env.PI_ANTHROPIC_AUTH_CLAUDE_CODE_VERSION;
delete process.env.PI_ANTHROPIC_AUTH_DEBUG;
const warnings: string[] = [];
console.warn = (s) => warnings.push(s);
const prefix = "You are an expert coding assistant operating inside pi, a coding agent harness.";
const docs = "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):\n- Main documentation: /oracle/README.md";
const filler = "In addition to the tools above, you may have access to other custom tools depending on the project.";
const phrase = "Here is some useful information about the environment you are running in:";
const tag = (n: string, b: string) => `<${n}>\n${b}\n</${n}>`;
const update = (n: string, b: string) => `Updated system prompt section "${n}":\n\n${tag(n,b)}`;
const fullPrompt = [prefix+" You help users.",tag("tools","- read: Read file contents\n\n"+filler),tag("rules",phrase),tag("docs",docs),tag("addendum","Keep this."),tag("project_context",`${phrase}\n${filler}`),tag("skills","Skill context."),tag("cwd","/oracle/project")].join("\n\n");
const promptInputs = ["", "just text", prefix+" unstructured",fullPrompt,
 fullPrompt.replace(docs,"User-provided documentation."),fullPrompt.replace(prefix,"A custom identity."),
 "<rules>\ntext\n</rules>", "preamble\n\n<other>\nx\n</other>", "<tools>\nunclosed", "<project_instructions path=\"a\">\nx\n</project_instructions>",
 "p\n\n<tools>\n<nested>\nx\n</nested>\n</tools>\n\n<rules>\nr\n</rules>",
 "p\n\n\n<tools>\nx\n</tools>\n\n\n<rules>\ny\n</rules>\n\ntail", "<Tools>\nx\n</Tools>",
 "<tools>\nx\n</tools>suffix\n\n<rules>\ny\n</rules>","<tools>\nx\n</tools>suffix\n</tools>",
];
const prompts=promptInputs.map(input=>({input,chunks:sections.parseSystemPromptChunks(input),shaped:shaping.shapeAnthropicOAuthSystemPrompt(input)}));
// Exercise conservative parsing around malformed/nested/extra-newline framing.
for(const sep of ["", "\n", "\n\n", "\n\n\n", "\r\n\r\n"]) for(const name of ["tools","extension-1","Bad","bad.name"]) {
 const input = `leading${sep}<${name}>\n😀 body\n</${name}>${sep}tail`;
 prompts.push({input,chunks:sections.parseSystemPromptChunks(input),shaped:shaping.shapeAnthropicOAuthSystemPrompt(input)});
}
const updateInputs=["", "Plain note.", update("docs",docs),update("docs","User docs"),update("tools","- read\n\n"+filler),update("rules",phrase),update("project_context",phrase),`Updated system prompt section "preamble":\n\n${prefix}`,`Removed system prompt section "docs".`,`Removed system prompt section "rules".`,`${update("docs",docs)}\n\n${update("tools","- read")}`,` Leading \n\n${update("docs",docs)}\n\n${update("rules",phrase)}  \n`,update("custom","<nested>\nx\n</nested>")];
const updates=updateInputs.map(input=>({input,result:shaping.shapeSystemUpdateText(input)??null}));
const userText="Please summarize this repository status.";
const billingCases=[];
for(const text of ["", "a", "Hello", userText, "abcd😀z😀abcdefghijkl😀tail", "😀😀😀😀😀😀😀😀😀😀😀😀", "abc\u0000defghijklmnopqrstuvwxyz", "é界☃́🇬🇧abcdefghijklmnopq", "x".repeat(100_000)]) for(const version of [versions.CLAUDE_CODE_VERSION,"2.9.9"]) billingCases.push({text,version,result:billing.buildBillingHeaderValue(text,version)??""});
const base = {model:"claude-haiku-4-5",stream:true,messages:[{role:"user",content:userText}],system:[{type:"text",text:fullPrompt,cache_control:{type:"ephemeral"},extra:"kept"}]};
const payloadInputs: unknown[] = [null,{}, {model:"x",stream:"true",messages:[]},base];
for(const system of [undefined,null,"bare system",["bare block",{text:"override",type:"other",extra:1},42],[{type:"text",text:billing.buildBillingHeaderValue(userText,versions.CLAUDE_CODE_VERSION)}],Array.from({length:4},(_,i)=>({type:"text",text:`block ${i}`,cache_control:{type:"ephemeral"}}))]) payloadInputs.push({...base,system});
for(const content of [[],"user string",[{type:"tool_result",output:"no text"}],[{type:"text",text:""},{type:"text",text:"later text"}],[{type:"image"},{type:"text",text:"first text"}]]) payloadInputs.push({...base,messages:[{role:"user",content},{role:"user",content:"do not use second user"}]});
for(const text of updateInputs) for(const effort of [undefined,null,{effort:"low"}]) payloadInputs.push({...base,messages:[{role:"user",content:userText},{role:"system",content:[{type:"text",text,cache_control:{type:"ephemeral"}}],...(effort!==undefined?{output_config:effort}:{})}]});
payloadInputs.push({...base,messages:[...base.messages,{role:"system",content:[{type:"text",text:update("docs",docs)},{type:"tool_addition",tool:{name:"read"}}]},{role:"assistant",content:[{type:"thinking",thinking:"signed",signature:"sig"},{type:"tool_use",name:"read",id:"id",input:{}},{type:"thinking",thinking:"interleaved",signature:"sig2"},{type:"text",text:"trailing"}]}]});
payloadInputs.push({...base,messages:[{role:"user",content:update("docs",docs)},{role:"assistant",content:[{type:"text",text:update("docs",docs)}]}]});
payloadInputs.push({...base,messages:[]}, {...base,messages:[{role:"system",content:[],output_config:{effort:"medium"}}]}, {...base,messages:[{role:"system",content:"unframed"}]});
const payloads=payloadInputs.map(input=>({input,result:shapeAnthropicOAuthPayload(input)}));
const configs=['{"providers":[{"z":1,"a":2,"10":"ten","2":"two","z":3}]}',"{}", '{"unknown":true}', '{"providers":["anthropic-2","anthropic","anthropic-2","Other.Name_3"]}', '{"providers":["bad/name","",null,1,false,{},[],"valid"]}', '{"providers":null}',"null","[]","42", "{", "invalid", '{"providers":[]}'].map(input=>({input,result:parseExtensionConfig(input,"/oracle/config.json")}));
const overrides=["","   "," 2.1.300 ","latest","2.1","v2.1.260","2.1.260-beta","\ufeff2.1.300\u00a0"].map(input=>{try{return {input,result:versions.resolveClaudeCodeVersion({[versions.CLAUDE_CODE_VERSION_ENV]:input})}}catch(e){return {input,error:(e as Error).message}}});
const userAgents=["","claude-cli/2.1.280","other/1 claude-cli/2.9.9 (external)","notclaude-cli/2.1.280","claude-cli/2.1.280.0","claude-cli/2.1.280-beta","claude-cli/v2.1.280","claude-cli/2.1.280\u00a0end","claude-cli/2.1.280\ufeffend"].map(input=>({input,result:versions.readClaudeCliVersion(input)??""}));
const higher=[];for(const baseline of ["2.1.280","2.9.9","02.001.000280","99999999999999999999999999.0.0"])for(const candidate of ["","invalid","2.1.280","2.1.300","2.10.0","3.0.0","99999999999999999999999998.0.0"])higher.push({baseline,candidate,result:versions.higherVersion(baseline,candidate)});
function rejection(required?:string) {return JSON.stringify({type:"error",error:{type:"invalid_request_error",message:required?`Claude Code 2.1.260 does not support this model; version ${required} or newer is required.`:"Model unsupported.",details:{error_code:"claude_code_version_too_old"}},request_id:"req_oracle"});}
const rejections=["not-json","{}",'{"error":{"details":{"error_code":"other"}}}',rejection("2.9.0"),rejection(),'{"error":{"message":17,"details":{"error_code":"claude_code_version_too_old"}}}'].map(input=>{const r=readClaudeCodeVersionRejection(input);return {input,result:r?{required:r.requiredVersion??"",hinted:JSON.parse(r.withHint("independent hint")),hintedText:r.withHint("independent hint")}:null}});
const hints=[{kind:"override",overrideVersion:"2.1.260",requiredVersion:"2.9.0"},{kind:"override",overrideVersion:"2.1.260"},{kind:"upgrade-pi",sentVersion:"2.1.280"},{kind:"set-override",requiredVersion:"2.9.5"},{kind:"set-override"}].map(input=>({input,result:describeRecoveryHint(input as never)}));
const syncCases=[];
for(const spec of [
 {name:"missing UA"},{name:"host behind",ua:"claude-cli/1.0.0"},{name:"host equal",ua:"claude-cli/2.1.280"},{name:"host ahead",ua:"claude-cli/2.9.9"},
 {name:"override absolute",ua:"claude-cli/2.9.9",override:"2.1.260"},{name:"learned floor",floor:"2.9.2"},
 {name:"no record",ua:"claude-cli/2.9.9",record:false},{name:"body not verifiable",ua:"claude-cli/2.9.9",body:"{}"},
 {name:"recover",required:["2.9.0"]},{name:"one retry",required:["2.9.0","2.9.5"]},{name:"floor satisfied",required:["2.1.200"]},{name:"retry floor satisfied",required:["2.9.0","2.9.0"]},
 {name:"override rejection",override:"2.1.260",required:["2.9.0"]},{name:"unknown floor",required:[null]}, {name:"no rebuild",record:false,required:["2.9.0"]},
 {name:"other 400",other400:true},{name:"opaque body",opaque:true,required:["2.9.0"]},
] as Array<{name:string;ua?:string;override?:string;floor?:string;record?:boolean;body?:string;required?:(string|null)[];other400?:boolean;opaque?:boolean}>) {
 const original={...base,system:[{type:"text",text:billing.buildBillingHeaderValue(userText,spec.override??versions.CLAUDE_CODE_VERSION)}]};
 if(spec.override)process.env[versions.CLAUDE_CODE_VERSION_ENV]=spec.override;else delete process.env[versions.CLAUDE_CODE_VERSION_ENV];
 const floor=versions.createLearnedClaudeCodeFloor();if(spec.floor)floor.learn(spec.floor);
 const sent:unknown[]=[];
 const fetch=async(_input:unknown,init?:RequestInit)=>{sent.push(init?.body);const required=spec.required?.[sent.length-1];return required!==undefined?new Response(rejection(required??undefined),{status:400,headers:{"request-id":"req_oracle","content-length":"123","content-encoding":"identity"}}):spec.other400?new Response("other400",{status:400}):new Response("streamed",{status:200})};
 const sync=createBillingVersionSync(floor,fetch as never);if(spec.record!==false)sync.recordRequest(original);
 const initial=spec.body??JSON.stringify(original);
 const response=await sync.fetch("https://oracle.invalid/messages",{method:"POST",headers:spec.ua?{"user-agent":spec.ua}:{},body:spec.opaque?new Uint8Array([1,2,3]):initial});
 syncCases.push({spec,original,initial,sent:sent.map(v=>typeof v==="string"?v:"<opaque>"),status:response.status,text:await response.text(),floor:floor.applyTo("1.0.0"),requestId:response.headers.get("request-id"),contentLength:response.headers.get("content-length"),contentEncoding:response.headers.get("content-encoding")});
}
delete process.env[versions.CLAUDE_CODE_VERSION_ENV];
const wrappers=[];
for(const key of ["","api-key","sk-ant-api03-x","sk-ant-oat-test","prefix-sk-ant-oat-suffix","other-oauth"])for(const action of ["none","mutate","replace","null","throw"]){
 let captured:any;const calls:string[]=[];const fetch=async()=>new Response("ok");
 const caller=action==="none"?undefined:async(p:any)=>{calls.push("caller");if(action==="throw")throw new Error("caller failed");if(action==="mutate"){p.extra="mutated";return undefined}if(action==="replace")return {...p,extra:"replaced"};return null};
 const wrapper=createAnthropicOAuthStreamSimple(((_m:any,_c:any,o:any)=>{captured=o;return "stream"}) as never);
 wrapper({api:"anthropic-messages"} as never,{} as never,{apiKey:key,onPayload:caller,fetch} as never);
 const input=structuredClone(base);let result,error;try{result=await captured.onPayload(input,{})}catch(e){error=(e as Error).message}
 wrappers.push({key,action,result,error,calls,fetchWrapped:captured.fetch!==fetch});
}
const profileBody={account:{email:"personal@example.test"},organization:{name:"Personal Org",organization_type:"claude_max",rate_limit_tier:"default_claude_max_20x",seat_tier:null,subscription_status:"active",has_extra_usage_enabled:false}};
const savedFetch=globalThis.fetch;globalThis.fetch=(async()=>new Response(JSON.stringify(profileBody))) as never;
const profile=await lookupProviderAccount("anthropic",{getApiKeyForProvider:async()=>"sk-ant-oat-test"});
const profileCases=[];
for(const text of ["{} trailing","[]","null","broken",JSON.stringify(profileBody),JSON.stringify({account:{email:42},organization:{name:false,has_extra_usage_enabled:"yes"}})]) {
 globalThis.fetch=(async()=>new Response(text)) as never;
 profileCases.push({text,result:await lookupProviderAccount("anthropic-2",{getApiKeyForProvider:async()=>"sk-ant-oat-test"})});
}
globalThis.fetch=savedFetch;
const diagnostic={version:"3.4.4",modulePath:"/oracle/anthropic-auth",transportResolved:true,shapedProviders:[{name:"anthropic-2",layer:"global"},{name:"anthropic-3",layer:"project"}],configWarnings:["config warning"]};
const reports=[false,true].map(includeIdentity=>({includeIdentity,result:formatDiagnosticsReport(diagnostic as never,{includeIdentity,accounts:[{provider:"anthropic",lookup:profile},{provider:"anthropic-2",lookup:{kind:"not-oauth"}},{provider:"anthropic-3",lookup:{kind:"unavailable",reason:"HTTP 401"}}]})}));
const completions=["","--","--acc"," --account ","other"].map(input=>({input,result:statusArgumentCompletions(input)}));
const output=JSON.stringify({prompts,updates,billingCases,payloads,configs,overrides,userAgents,higher,rejections,hints,syncCases,wrappers,profileCases,profileBody,profile,reports,completions},null,1)+"\n";
const path=join(here,"golden.json");
if(process.argv.includes("--check")){if(readFileSync(path,"utf8")!==output)throw new Error("anthropicauth golden.json is stale");console.log("anthropicauth golden.json is current")}else{writeFileSync(path,output);console.log("anthropicauth golden.json generated from upstream v3.4.4")}
