import {createModelClient} from '../src/model-client.mjs';
const client=createModelClient();
for(const requested of [131072,131073]){
  let metadata={};
  try{
    const text=await client.generateReview({instructions:'This is a synthetic API limit probe. Return only OK.',input:'Return exactly OK.',disableThinking:true,maxOutputTokens:requested,onMetadata:value=>metadata=value});
    console.log(JSON.stringify({requested,accepted:true,stopReason:metadata.stopReason,outputTokens:metadata.outputTokens,reasoningTokens:metadata.reasoningTokens,nonempty:Boolean(text)}));
  }catch(error){
    console.log(JSON.stringify({requested,accepted:false,status:Number.isInteger(error.status)?error.status:undefined,code:['incomplete_response'].includes(error.code)?error.code:'request_error',reason:['output_truncated','empty_response','response_refused','response_protocol'].includes(error.reason)?error.reason:undefined}));
  }
}
