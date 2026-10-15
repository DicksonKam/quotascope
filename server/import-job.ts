import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
export class ImportJob {
 private child:ChildProcess|null=null;
 private flight:Promise<boolean>|null=null;
 private stopping=false;
 constructor(private dir:string,private timeoutMs=120000,private entry=new URL('./import-worker.ts',import.meta.url),private extraEnv:Record<string,string>={}){}
 run():Promise<boolean>{
  if(this.flight)return this.flight;
  if(this.stopping)return Promise.resolve(false);
  this.flight=new Promise<boolean>(resolve=>{
   const child=this.child=spawn(process.execPath,['--import','tsx',fileURLToPath(this.entry)],{env:{...process.env,QUOTASCOPE_DATA_DIR:this.dir,...this.extraEnv},stdio:'ignore'});
   let expired=false,killer:ReturnType<typeof setTimeout>|undefined;
   const timer=setTimeout(()=>{expired=true;child.kill('SIGTERM');killer=setTimeout(()=>child.kill('SIGKILL'),1500);},this.timeoutMs);
   child.once('error',()=>finish(false));
   child.once('exit',code=>finish(code===0&&!expired&&!this.stopping));
   let finished=false;
   const finish=(ok:boolean)=>{if(finished)return;finished=true;clearTimeout(timer);clearTimeout(killer);this.child=null;resolve(ok);};
  }).finally(()=>{this.flight=null;});
  return this.flight;
 }
 async stop(){this.stopping=true;const child=this.child;child?.kill('SIGTERM');const killer=setTimeout(()=>child?.kill('SIGKILL'),1500);try{await this.flight;}finally{clearTimeout(killer);}}
}
