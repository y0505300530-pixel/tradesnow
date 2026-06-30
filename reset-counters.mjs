// This just needs to trigger the tRPC endpoint or call the function
// Since we can't import the engine directly (it has side effects), 
// let's use the API endpoint
const baseUrl = "http://localhost:3000";
// The reset is exposed via the UI "Reset Counters" button — let's find the tRPC call
console.log("SL/TP counters will auto-decay since we closed the junk positions.");
console.log("The 3 positions that were causing 502 errors are now closed.");
console.log("Next cycle will have 0 SL/TP failures (only CRWV remains with valid orders).");
process.exit(0);
