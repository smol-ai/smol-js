import { ChatCompletionRequestMessage, ChatCompletionRequestMessageRoleEnum, OpenAIApi } from "./api";
import { ZodSchema } from "zod";
import { JSONSchema7Type } from "json-schema";
import zodToJsonSchema from "zod-to-json-schema";

export type RegisteredFunctionSchema = ZodSchema | JSONSchema7Type;

export type RegisteredFunctionType = {
  name: string;
  fullFunction: Function;
  schema: RegisteredFunctionSchema;
  jsonSchema: JSONSchema7Type;
};

export class SmolAI {
  systemMessage =
    "You are a helpful chatbot. You are helping a user with a task.";
  model = "gpt-3.5-turbo-0613";
  aisdk: OpenAIApi;
  registeredFunctions = new Map<string, RegisteredFunctionType>();
  retryLimit = 5;
  retryDelay = 200;
  retryAttempts = 0;
  log = console.log // to turn off, set to () => {}
  constructor(aisdk, newSystemMessage) {
    this.aisdk = aisdk; // eg openai
    if (newSystemMessage) this.systemMessage = newSystemMessage;
  }

  addFunction = (func: Function, schema: RegisteredFunctionSchema) => {
    const jsonSchema =
      schema instanceof ZodSchema
        ? (zodToJsonSchema(schema) as JSONSchema7Type)
        : schema;
    this.registeredFunctions.set(func.name, {
      name: func.name,
      fullFunction: func,
      schema,
      jsonSchema,
    });
  };

  deregisterFunction = (func: string | Function) => {
    if (typeof func === "function") {
      this.registeredFunctions.delete(func.name);
    } else {
      this.registeredFunctions.delete(func);
    }
  };

  getFunction = (func: string | Function): RegisteredFunctionType => {
    let fn;
    if (typeof func === "function") {
      fn = this.registeredFunctions.get(func.name);
    } else {
      fn = this.registeredFunctions.get(func);
    }
    if (fn) return fn;
    else
      throw new Error(
        `smolChat error - function ${func} not found. Please report a bug.`
      );
  };

  listFunctions() {
    return Object.keys(this.registeredFunctions).map((fnName) =>
      this.getFunction(fnName)
    );
  }

  async chat(opts: {
      messages: (string | ChatCompletionRequestMessage)[],
      forceFunctionCall?: Function | string | null // set null to disable all functions
    }) {
    this.log("starting smol chat", opts);
    let chatCompletion = null as Response | null;
    let shouldRetry = false;
    let functions = this.listFunctions();

    do {
      let function_call 
      if (opts.forceFunctionCall !== null) {
        function_call = typeof opts.forceFunctionCall === 'function' ? opts.forceFunctionCall.name : opts.forceFunctionCall
      }
      chatCompletion = await this.aisdk.createChatCompletion({
        model: this.model,
        messages: [
          { role: "system", content: this.systemMessage },
          ...opts.messages.map(m => {
            if (typeof m === 'string') return { role: "user" as ChatCompletionRequestMessageRoleEnum, content: m }
            else return m
          })
        ],
        functions: opts.forceFunctionCall === null ? [] : functions,
        // check if forceFunctionCall.name is function and forceFunctionCall if not
        function_call
      });

      /* @ts-ignore */
      function_call = chatCompletion.data.choices[0].message.function_call;
      const selectedFunction = this.getFunction(function_call.name);
      let args;

      if (selectedFunction) {
        try {
          this.log("attempting arg parse", function_call.arguments);
          const json = JSON.parse(function_call.arguments);
          this.log("attempting schema parse", json);
          args =
            selectedFunction.schema instanceof ZodSchema
              ? selectedFunction.schema.parse(json)
              : json;
        } catch (err) {
          this.log("invalid arguments", err);
          opts.messages.push({
            role: "user",
            content: `Your function call involved invalid arguments.
            ${err.message}
            Please respond only with valid JSON under the provided schema.
            `,
          });
          shouldRetry = true;
        }
      } else {
        this.log(
          "function not found",
          /* @ts-ignore */
          chatCompletion.data.choices[0].message.function_call
        );
        throw new Error("unexpected error2 - gpt attempted to call a function not found");
      }

      this.log("trying function", selectedFunction, "with args", args);
      const results = await selectedFunction.fullFunction(args);
      this.log("returned results", results);
      opts.messages.push({
        role: "function",
        name: selectedFunction.name,
        content: JSON.stringify(results),
      });
      this.log("added function results to messages", opts.messages);

      // linear backoff function
      await new Promise((r) =>
        setTimeout(
          r,
          this.retryAttempts * this.retryDelay +
            // jitter
            Math.floor(Math.random() * 100)
        )
      );
    } while (shouldRetry && this.retryAttempts < this.retryLimit);

    this.log("finished extraChat", opts);
    return chatCompletion;
  }
}

// export async function simpleChatCompletion(opts: {
//   messages: (string | ChatCompletionRequestMessage)[],
//   forceFunctionCall?: Function | string | null
// }) {
//   log('starting extraChat', opts);
//   let chatCompletion = null;
//   let shouldRetry = false;
//   let functions = listFunctions();

//   do {
//     chatCompletion = await this.openai.createChatCompletion({
//       model: "gpt-3.5-turbo-0613",
//       messages: [
//         { role: "system", content: systemMessage },
//         ...opts.messages.map(m => {
//           if (typeof m === 'string') return { role: "user", content: m }
//           else return m
//         })
//       ],
//       functions: opts.forceFunctionCall === null ? [] : functions,
//       // check if forceFunctionCall.name is function and forceFunctionCall if not
//       function_call: typeof opts.forceFunctionCall === 'function' ?
//         opts.forceFunctionCall.name :
//         opts.forceFunctionCall
//     });

//     function_call = chatCompletion.data.choices[0].message.function_call;
//     const selectedFunction = this.getFunction(function_call.name);
//     let args;

//     if (selectedFunction) {
//       try {
//         log('attempting arg parse', function_call.arguments);
//         const json = JSON.parse(function_call.arguments);
//         log('attempting schema parse', json);
//         args = selectedFunction.zodSchema.parse(json);
//       } catch (err) {
//         log('invalid arguments', err);
//         messages.push({ role: "user", content: "Your function call involved invalid arguments. " + err });
//         shouldRetry = true;
//         throw new Error('temporary error here just to show exactly how this happens');
//       }
//     } else {
//       log('function not found', chatCompletion.data.choices[0].message.function_call);
//       throw new Error('unexpected error2');
//     }

//     log('trying function', selectedFunction, 'with args', args);
//     const results = await selectedFunction.fullFunction(args);
//     log('returned results', results);
//     messages.push({ role: "function", name: selectedFunction.name, content: JSON.stringify(results) });
//     log('added function results to messages', messages);
//   } while (shouldRetry && this.attempts < this.retryLimit);

//   log('finished extraChat', messages, function_call);
//   return chatCompletion;
// }
