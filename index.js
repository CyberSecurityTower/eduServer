 const express = require('express');
    const cors = require('cors');
    const { GoogleGenerativeAI } = require("@google/generative-ai");

    const app = express();
    app.use(cors());
    app.use(express.json());

    // Check for the API key from environment variables (Secrets)
    if (!process.env.GOOGLE_API_KEY) {
      // This will cause the server to crash on startup if the key is missing,
      // which is good for debugging.
      throw new Error("FATAL ERROR: GOOGLE_API_KEY is not defined in environment variables.");
    }

    // Initialize Google AI with the key
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

    // The ONLY endpoint our server needs
    app.post('/chat', async (req, res) => {
      try {
        // --- THE FINAL ATTEMPT WITH A MODERN, STABLE MODEL ---
        // This model is one of the latest and most common.
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        
        const userMessage = req.body.message;
        if (!userMessage) {
          return res.status(400).json({ error: 'Message is required' });
        }

        const result = await model.generateContent(userMessage);
        const response = await result.response;
        const botReply = response.text();

        // Send the bot's reply back to your app
        res.json({ reply: botReply });

      } catch (error) {
        // Log the detailed error on the server for us to see
        console.error("Error processing chat:", error.message);
        // Send a generic error to the app
        res.status(500).json({ error: "An error occurred while communicating with the AI." });
      }
    });

    // Start the server
    const port = process.env.PORT || 10000;
    app.listen(port, () => {
      console.log(`Server is running on port ${port}`);
    });
