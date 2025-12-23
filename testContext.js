
// testContext.js
require('dotenv').config();
const { getCurriculumContext } = require('./src/services/ai/curriculumContext');

async function test() {
    console.log("⏳ Testing Curriculum Context Fetching...");
    try {
        const context = await getCurriculumContext();
        console.log("\n================ RESULT ================");
        console.log(context);
        console.log("========================================");
        
        if (context.includes("Subject:")) {
            console.log("✅ SUCCESS: The AI can see the subjects!");
        } else {
            console.log("❌ FAILURE: Context is empty or generic.");
        }
    } catch (e) {
        console.error("❌ ERROR:", e);
    }
    process.exit();
}

test();
