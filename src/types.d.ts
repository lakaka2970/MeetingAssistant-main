import type { McApi } from '../electron/preload';
import type { McSetupApi } from '../electron/setupPreload';
import type { McExamApi } from '../electron/examPreload';
import type { McConnectApi } from '../electron/connectPreload';

declare global {
  interface Window {
    mc: McApi;
    /** setup window only (src/setup.html + electron/setupPreload.ts) */
    mcSetup: McSetupApi;
    /** exam window only (src/exam.html + electron/examPreload.ts) */
    mcExam: McExamApi;
    /** dual-screen connect window only (src/connect.html + electron/connectPreload.ts) */
    mcConnect: McConnectApi;
    /** E2E hook: main calls this (with user gesture) when MC_AUTOSTART=1 */
    __mcAutoStart?: () => void;
    /** visual-QA hooks: main calls these when MC_MAIN_SHOT=<dir> */
    __mcOpenSettings?: () => void;
    __mcOpenHelp?: () => void;
    __mcOpenKnowledge?: () => void;
  }
}

export {};
