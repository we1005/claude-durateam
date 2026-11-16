import {it,expect} from "vitest";
import {mkdirSync,mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {InstanceManager} from "../src/instances/manager.js";
import {Scheduler} from "../src/scheduler/scheduler.js";
import {SqliteStateStore} from "../src/state/sqlite.js";
import {FakeRunner,FakeWorkspace,baseTask,flush} from "./scheduler-doubles.js";

it("discovers foreign jobs read-only, refuses active takeover, then resumes exact session after owner exits", async()=>{
  const base=mkdtempSync(join(tmpdir(),"cdt-handoff-route-"));
  const project=join(base,"project");mkdirSync(project);
  for(const id of ["one","two"]){
    const runtime=join(base,"instances",id);mkdirSync(runtime,{recursive:true});
    writeFileSync(join(runtime,`connection-${process.pid}.json`),JSON.stringify({instance:id,pid:process.pid,createdAt:new Date().toISOString(),runtime,stateDb:join(runtime,"state.db")}));
  }
  const firstRunner=new FakeRunner();const secondRunner=new FakeRunner();
  const create=(id:string,runner:FakeRunner)=>new Scheduler({runner,workspace:new FakeWorkspace(),store:new SqliteStateStore({path:join(base,"instances",id,"state.db"),registerExitHandler:false}),closeGraceMs:20});
  const first=create("one",firstRunner);const second=create("two",secondRunner);
  const factory=async(runtime:string,stateDb:string)=>{
    const store=new SqliteStateStore({path:stateDb,registerExitHandler:false});
    try{
      const scheduler=new Scheduler({runner:secondRunner,workspace:new FakeWorkspace(),store,closeGraceMs:20});
      return {scheduler,info:{available:true},cleanup:()=>scheduler.close()};
    }catch(error){store.close();throw error;}
  };
  const m1=new InstanceManager(base,"one",first,factory);
  const m2=new InstanceManager(base,"two",second,factory);
  try{
    const job=await first.spawn(baseTask({cwd:project}));await flush();
    firstRunner.runs[0]!.resolve({sessionId:"9cbd3348-1220-49af-aeb6-f78ba398e559"});await flush();
    await m1.handoff({action:"save",cwd:project,jobId:job.jobId,goal:"same module",completed:"base done",next:"add increment"});
    const stored=m2.listStored(project);expect(stored).toHaveLength(1);expect(stored[0]!.instanceId).toBe("one");
    const note=await m2.handoff({action:"read",cwd:project}) as any;
    expect(note.resumeHint).toMatchObject({instanceId:"one",jobId:job.jobId,prompt:"add increment"});
    await expect(m2.resolve("one")).rejects.toThrow(/ownership|owner/i);
    await first.close();
    const recovered=await m2.resolve("one");
    expect(recovered.status(job.jobId).sessionId).toBe("9cbd3348-1220-49af-aeb6-f78ba398e559");
    await recovered.followUp(job.jobId,"add increment");await flush();
    expect(secondRunner.runs[0]!.request.resumeSessionId).toBe("9cbd3348-1220-49af-aeb6-f78ba398e559");
    secondRunner.runs[0]!.resolve();await flush();
    expect((await m2.resolve("one"))).toBe(recovered);
  }finally{await m2.close();await m1.close();await first.close();await second.close();rmSync(base,{recursive:true,force:true});}
});
