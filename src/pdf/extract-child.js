import {extractPdf} from './extract-inprocess.js';
process.once('message',async raw=>{try{const result=await extractPdf(raw);process.send({ok:true,result});}catch(error){process.send({ok:false,error:error.message});}});
