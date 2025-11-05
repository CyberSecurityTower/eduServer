
# CHANGELOG

## v1.0.0 - 2023-10-27

### Added
-   **Project Structure:** Implemented a new, modular directory structure (`config/`, `controllers/`, `services/`, `utils/`, `middleware/`, `routes/`, `tests/`).
-   **Centralized Configuration:** Created `config/index.js` for all application settings.
-   **Unified Logging:** Introduced `utils/logger.js` for consistent logging.
-   **Core Utilities:** Consolidated general utility functions into `utils/index.js`.
-   **Request ID Middleware:** Added `middleware/requestId.js` for request tracking.
-   **Firestore Service:** Created `services/data/firestore.js` for centralized Firebase Admin initialization.
-   **Data Helpers:** Grouped Firestore-related data access and formatting functions in `services/data/helpers.js`.
-   **AI Core Services:** Separated AI model pool initialization (`services/ai/index.js`) and failover logic (`services/ai/failover.js`).
-   **AI Managers:** Created dedicated modules for each AI manager (`conversationManager`, `curriculumManager`, `memoryManager`, `notificationManager`, `plannerManager`, `quizManager`, `reviewManager`, `suggestionManager`, `trafficManager`, `todoManager`) under `services/ai/managers/`.
-   **Job Queue Services:** Separated job enqueueing (`services/jobs/queue.js`) and worker logic (`services/jobs/worker.js`).
-   **Controllers:** Created dedicated controllers for different API domains (`chatController`, `analyticsController`, `tasksController`, `quizController`, `adminController`) under `controllers/`.
-   **Routes:** Centralized API route definitions in `routes/index.js`.
-   **Main Application File:** Created `app.js` for Express application setup.
-   **Entry Point:** Refactored `index.js` as the main entry point responsible for service initialization and server startup.
-   **Unit Tests:** Added basic unit tests for chat functionality and utilities (`tests/chat.test.js`, `tests/utils.test.js`).
-   **README.md:** Comprehensive README file explaining the new structure and deployment.

### Changed
-   **`index.js` (Old):** Completely refactored and split into `app.js` and the new `index.js` entry point.
-   **`cache.js`:** Moved to `services/data/cache.js` without functional changes.
-   **`embeddings.js`:** Moved to `services/embeddings.js` and updated to use centralized Firestore and logger.
-   **`memoryManager.js`:** Moved to `services/ai/managers/memoryManager.js` and updated for dependency injection and centralized logger.
-   **`indexCurriculum.js`:** Updated to use centralized `config`, `firestore`, and `logger`.
-   **`package.json`:** Updated `start` script, added `dotenv` and `cli-progress` as dependencies, and added `test` script.
-   **Dependency Management:** Switched to explicit dependency injection for cross-module communication where direct `require` could cause circular dependencies.
-   **Error Handling & Logging:** Integrated `utils/logger.js` across the application for consistent error and information logging.

### Removed
-   All inline configurations, utilities, and manager functions from the original `index.js`.
