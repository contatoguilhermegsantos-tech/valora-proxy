const norm=(v:any)=>String(v??"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toUpperCase().replace(/[^A-Z0-9 ]/g," ").replace(/\s+/g," ").trim();
const clamp=(n:number)=>Math.max(0,Math.min(100,Math.round(n)));
function tokenOverlap(a:string,b:string){
  const A=new Set(norm(a).split(" ").filter(x=>x.length>2));
  const B=new Set(norm(b).split(" ").filter(x=>x.length>2));
  if(!A.size||!B.size)return 0;
  let hit=0;for(const x of A)if(B.has(x))hit++;
  return hit/Math.max(A.size,B.size);
}
function companyReferenceScore(reference:string|null,company:string|null,trade:string|null){
  if(!reference)return {points:0,kind:"NONE"};
  const r=norm(reference), c=norm(company), t=norm(trade);
  if(r&&(r===c||r===t))return {points:25,kind:"EXACT"};
  if(r&&((c&&c.includes(r))||(t&&t.includes(r))||(c&&r.includes(c))||(t&&r.includes(t))))return {points:18,kind:"CONTAINS"};
  const overlap=Math.max(tokenOverlap(r,c),tokenOverlap(r,t));
  if(overlap>=0.60)return {points:15,kind:"TOKEN_OVERLAP"};
  if(overlap>=0.35)return {points:8,kind:"WEAK_OVERLAP"};
  return {points:0,kind:"NO_MATCH"};
}


export function assessIdentity(lead:any,candidates:any[]){
  const scored=(candidates||[]).map((c:any)=>{
    if(c.validation_status==="CONFIRMED"){
      return {candidate:c,score:100,decision:"CONFIRMED",factors:{user_confirmed:true}};
    }
    const md=c.metadata||{};
    let score=0;
    const cross=md.cross_identity_validation||null;
    const factors:any={};
    const exact=Boolean(norm(md.partner_name) && norm(md.partner_name)===norm(lead.name));
    if(exact){score+=35;factors.exact_name={matched:true,points:35}}else factors.exact_name={matched:false,points:0};

    if(lead.city){
      const city=Boolean(norm(md.city) && norm(md.city)===norm(lead.city));
      score+=city?25:-10; factors.city={matched:city,points:city?25:-10,lead:lead.city,candidate:md.city||null};
    }else factors.city={matched:null,points:0};

    if(lead.state){
      const st=Boolean(norm(md.state) && norm(md.state)===norm(lead.state));
      score+=st?10:-8; factors.state={matched:st,points:st?10:-8,lead:lead.state,candidate:md.state||null};
    }else factors.state={matched:null,points:0};

    const ref=companyReferenceScore(lead.reference_company||null,md.company_name||null,md.trade_name||null);
    score+=ref.points; factors.reference_company={match:ref.kind,points:ref.points,lead:lead.reference_company||null,candidate:md.company_name||md.trade_name||null};

    if(md.full_cnpj){score+=5;factors.cnpj_completeness={present:true,points:5}}
    else factors.cnpj_completeness={present:false,points:0};

    if(cross?.matched){
      score+=15;
      factors.cross_qsa_identity={matched:true,points:15,group_id:cross.group_id||null,group_size:cross.group_size||null,method:cross.method||null};
    }else factors.cross_qsa_identity={matched:false,points:0};

    if(norm(lead.name).split(" ").filter(Boolean).length<2){score-=15;factors.name_quality={points:-15,reason:"short_or_incomplete_name"}}
    else factors.name_quality={points:0};

    score=clamp(score);
    const decision=score>=75?"SUPPORTED":score>=45?"REVIEW":"WEAK";
    const clusterKey=cross?.matched&&cross?.group_id?("cross:"+String(cross.group_id)):("candidate:"+c.id);
    return {candidate:c,score,decision,factors,clusterKey};
  }).sort((a:any,b:any)=>b.score-a.score);

  const top=scored[0]||null;
  const secondDistinct=top?scored.find((x:any)=>x.candidate.id!==top.candidate.id&&x.clusterKey!==top.clusterKey&&x.decision!=="CONFIRMED"):null;
  const ambiguous=Boolean(top&&secondDistinct&&top.decision!=="CONFIRMED"&&top.score>=60&&secondDistinct.score>=60&&Math.abs(top.score-secondDistinct.score)<=8);
  const ambiguousCandidateIds=new Set(
    ambiguous&&top
      ? scored.filter((x:any)=>x.decision!=="CONFIRMED"&&x.score>=60&&Math.abs(top.score-x.score)<=8).map((x:any)=>x.candidate.id)
      : []
  );

  return {scored,top,ambiguous,ambiguousCandidateIds};
}


