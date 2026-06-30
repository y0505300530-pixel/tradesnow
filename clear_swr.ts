import * as dotenv from "dotenv";
dotenv.config();
import { swrInvalidate } from "./server/swrCache";
swrInvalidate("portfolio:state:1");
console.log("SWR invalidated");
process.exit(0);
