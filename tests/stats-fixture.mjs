import Worker from '../build/index.js';
let points=[];
const logs=[];
const originalError=console.error.bind(console);
console.error=(...args)=>{logs.push(args.join(" "));originalError(...args);};
let fail=false;
export default class extends Worker {
 constructor(ctx,env) {super(ctx,{...env,ANALYTICS:{writeDataPoint(point){ if(fail) throw new Error('secret-must-not-leak'); points.push(point);}}}); }
 async fetch(req){
  const url=new URL(req.url);
  if(url.pathname==='/test-logs') return Response.json(logs);
  if(url.pathname==='/test-points'){if(req.method==='DELETE')points=[]; return Response.json(points);}
  if(url.pathname==='/test-fail'){fail=url.searchParams.get('value')==='1'; return new Response('ok');}
  return super.fetch(req);
 }
}
