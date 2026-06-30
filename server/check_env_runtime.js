const { ENV } = require("./_core/env");
console.log("ENV.ibindApiSecret len:", ENV.ibindApiSecret?.length);
console.log("process.env.IBIND_API_SECRET len:", process.env.IBIND_API_SECRET?.length);
