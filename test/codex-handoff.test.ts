import {it,expect} from 'vitest';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {SqliteStateStore} from '../src/state/sqlite.js';
import {seedSnapshot,baseTask,FakeWorkspace} from './scheduler-doubles.js';

it('new Codex connection discovers and addresses old jobs without a global instance env switch',async()=>{
  const base=mkdtempSync(join(tmpdir(),'cdt-mcp-handoff-'));const project=join(base,'project');mkdirSync(project);
  const workspace=new FakeWorkspace();const [task]=await workspace.prepareBatch([baseTask({cwd:project})]);
  const snap=seedSnapshot({jobId:'CDT-00001',sessionId:'9cbd3348-1220-49af-aeb6-f78ba398e559',state:'succeeded',task});
  const db=join(base,'instances/one/state/claude-durateam.db');
  const store=new SqliteStateStore({path:db,registerExitHandler:false});store.acquireOwner();store.save(snap);store.close();
  const clients:Client[]=[];
  async function connect(id:string){
    const c=new Client({name:'handoff-test',version:'1'});clients.push(c);
    await c.connect(new StdioClientTransport({command:process.execPath,args:[resolve('scripts/codex-mcp-launcher.mjs')],stderr:'pipe',
      env:{PATH:process.env.PATH??'',HOME:base,CLAUDE_DURATEAM_RUNTIME:base,CLAUDE_DURATEAM_INSTANCE:id,CLAUDE_DURATEAM_ALLOWED_ROOTS:base,
        CLAUDE_DURATEAM_KEY_FILE:join(base,'absent-key'),CLAUDE_DURATEAM_MAX_CONCURRENT:'5'}}));
    return c;
  }
  async function call(c:Client,name:string,args:Record<string,unknown>={}){
    const r=await c.callTool({name,arguments:args});return {error:!!r.isError,value:JSON.parse((r.content as {text:string}[])[0]!.text)};
  }
  try{
    const first=await connect('one');
    expect((await call(first,'init')).value.scheduler.maxConcurrent).toBe(5);
    expect((await call(first,'handoff',{action:'save',cwd:project,jobId:snap.jobId,goal:'module',completed:'done',next:'increment'})).error).toBe(false);
    const second=await connect('two');
    const sessions=(await call(second,'sessions',{cwd:project,includeStored:true})).value;
    expect(sessions.stored).toHaveLength(1);expect(sessions.stored[0]).toMatchObject({instanceId:'one',jobId:snap.jobId});
    expect((await call(second,'status',{instanceId:'one',jobId:snap.jobId})).error).toBe(true);
    await first.close();
    const status=await call(second,'status',{instanceId:'one',jobId:snap.jobId});
    expect(status.error).toBe(false);expect(status.value).toMatchObject({instanceId:'one',jobId:snap.jobId,sessionId:snap.sessionId});
    const note=(await call(second,'handoff',{action:'read',cwd:project})).value;
    expect(note.resumeHint).toMatchObject({instanceId:'one',jobId:snap.jobId,prompt:'increment'});
  }finally{await Promise.all(clients.map(c=>c.close()));rmSync(base,{recursive:true,force:true});}
},30000);
