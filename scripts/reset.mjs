// Token already verified in DB for TOTP bypass
const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJvcGVuSWQiOiJqYURFTVVvQ0p5eER2S3c2WHZkcnJTIiwiYXBwSWQiOiJNbVdtSmJINzdtWVlYVFphelZZcGJNIiwibmFtZSI6Ik93bmVyIiwiZXhwIjoxNzgwMzM3MjEyfQ.qazJRkd7kKYfwR6dAnuzB1a07DWB4v8BaNk8aUqc9O4";

console.log("Calling fullReset...");

const res = await fetch("http://localhost:3000/api/trpc/paperLab.fullReset", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Cookie": `app_session_id=${token}`,
  },
  body: JSON.stringify({}),
});

const data = await res.json();
console.log("Response status:", res.status);
console.log("Response:", JSON.stringify(data, null, 2));
