"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_DURATION = exports.MIN_DURATION = exports.PRICE_PER_SECOND = exports.MAX_CONCURRENT_TASKS = exports.DOWNLOAD_DIR = exports.GEN_TIMEOUT = exports.BROWSER_TIMEOUT = exports.HEADLESS = exports.BEHAVIOR = exports.SCHEDULE = exports.WORKER_NAME = exports.CALLBACK_ENDPOINT = exports.FETCH_TASK_ENDPOINT = exports.TASK_SERVER_URL = exports.JIMENG_URL = exports.STORAGE_TYPE = exports.ENABLE_CLOUD_STORAGE = exports.QINIU_PREFIX = exports.QINIU_DOMAIN = exports.QINIU_ZONE = exports.QINIU_BUCKET = exports.QINIU_SECRET_KEY = exports.QINIU_ACCESS_KEY = exports.OSS_PREFIX = exports.OSS_BUCKET = exports.OSS_REGION = exports.OSS_ACCESS_KEY_SECRET = exports.OSS_ACCESS_KEY_ID = exports.COS_PREFIX = exports.COS_BUCKET = exports.COS_REGION = exports.COS_SECRET_KEY = exports.COS_SECRET_ID = exports.NODE_ENV = void 0;
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const dotenv = __importStar(require("dotenv"));
// ==========================================
// 🔧 环境变量加载
// 根据 NODE_ENV 自动加载对应的 .env 文件
// .env 文件查找顺序: 运行目录 > 可执行文件目录
// ==========================================
const NODE_ENV = process.env.NODE_ENV || 'development';
exports.NODE_ENV = NODE_ENV;
// 查找 .env 文件的目录列表 (优先级从高到低)
const searchDirs = [
    process.cwd(), // 运行目录 (node 命令执行的目录)
    __dirname, // 可执行文件所在目录 (dist/)
];
// 查找 .env 文件
function findEnvFile() {
    const envNames = [`.env.${NODE_ENV}`, '.env'];
    for (const dir of searchDirs) {
        for (const name of envNames) {
            const filePath = path.join(dir, name);
            if (fs.existsSync(filePath)) {
                return filePath;
            }
        }
    }
    return null;
}
const envFile = findEnvFile();
if (envFile) {
    dotenv.config({ path: envFile });
    console.log(`[Config] 环境: ${NODE_ENV}, 配置: ${envFile}`);
}
else {
    console.log(`[Config] 未找到 .env 文件，使用默认值`);
}
// ==========================================
// ☁️ 腾讯云 COS 配置 (与 cloudmain 保持一致)
// ==========================================
exports.COS_SECRET_ID = process.env.COS_SECRET_ID || '';
exports.COS_SECRET_KEY = process.env.COS_SECRET_KEY || '';
exports.COS_REGION = process.env.COS_REGION || 'ap-hongkong';
exports.COS_BUCKET = process.env.COS_BUCKET || 'qwq-1393920019';
exports.COS_PREFIX = 'seedance/'; // COS 中的存储目录前缀
// ==========================================
// ☁️ 阿里云 OSS 配置
// ==========================================
exports.OSS_ACCESS_KEY_ID = process.env.OSS_ACCESS_KEY_ID || '';
exports.OSS_ACCESS_KEY_SECRET = process.env.OSS_ACCESS_KEY_SECRET || '';
exports.OSS_REGION = process.env.OSS_REGION || 'oss-cn-hangzhou';
exports.OSS_BUCKET = process.env.OSS_BUCKET || '';
exports.OSS_PREFIX = process.env.OSS_PREFIX || 'seedance/';
// ==========================================
// ☁️ 七牛云配置
// ==========================================
exports.QINIU_ACCESS_KEY = process.env.QINIU_ACCESS_KEY || '';
exports.QINIU_SECRET_KEY = process.env.QINIU_SECRET_KEY || '';
exports.QINIU_BUCKET = process.env.QINIU_BUCKET || '';
exports.QINIU_ZONE = process.env.QINIU_ZONE || 'z0'; // z0华东 z1华北 z2华南 na0北美 as0东南亚
exports.QINIU_DOMAIN = process.env.QINIU_DOMAIN || ''; // 七牛云绑定的域名
exports.QINIU_PREFIX = process.env.QINIU_PREFIX || 'seedance/';
// ==========================================
// 📦 资源存储配置
// ==========================================
// 是否开启保存资源到云存储
exports.ENABLE_CLOUD_STORAGE = process.env.ENABLE_CLOUD_STORAGE === 'true';
exports.STORAGE_TYPE = process.env.STORAGE_TYPE || 'cos';
// ==========================================
// 🎬 即梦 (JiMeng) 配置
// ==========================================
exports.JIMENG_URL = 'https://jimeng.jianying.com/ai-tool/generate?type=video';
// Cookie 通过 Playwright persistent context 自动管理，无需手动配置
// ==========================================
// 🖥️ 总服务器配置
// ==========================================
exports.TASK_SERVER_URL = process.env.TASK_SERVER_URL || 'http://8.217.104.228:8000';
// Worker 拉取任务的接口
exports.FETCH_TASK_ENDPOINT = '/api/seedance/fetch_task';
// Worker 回报结果的接口
exports.CALLBACK_ENDPOINT = '/api/seedance/callback';
// ==========================================
// 🎭 Worker 人格配置 (反风控核心)
// ==========================================
exports.WORKER_NAME = (process.env.WORKER_NAME || 'worker_01').trim();
// 作息模式 (概率性，不是固定的)
exports.SCHEDULE = {
    weekday_start_hour: [8, 10], // 工作日上线时间范围
    weekday_end_hour: [22, 24], // 工作日下线时间范围
    weekend_work_prob: 0.3, // 周末上班概率 30%
    weekend_start_hour: [10, 14], // 周末上线更晚
    weekend_end_hour: [18, 22], // 周末下线更早
    lunch_break_prob: 0.7, // 午休概率 70% (12:00-13:30)
    dinner_break_prob: 0.5, // 晚饭休息概率 50% (18:00-19:00)
};
// 行为模式
exports.BEHAVIOR = {
    task_interval_range: [45, 200], // 两次任务之间间隔(秒)
    random_afk_prob: 0.05, // 5% 概率随机 AFK 5-15 分钟
    burst_mode_prob: 0.08, // 8% 概率进入赶工模式(间隔缩短)
    burst_interval_range: [20, 60], // 赶工模式下的间隔(秒)
    typing_speed_range: [0.03, 0.12], // 模拟打字速度(秒/字符)
};
// ==========================================
// 🌐 Playwright 浏览器配置
// ==========================================
exports.HEADLESS = process.env.HEADLESS === 'true'; // 从环境变量读取
exports.BROWSER_TIMEOUT = parseInt(process.env.BROWSER_TIMEOUT || '60000', 10);
exports.GEN_TIMEOUT = parseInt(process.env.GEN_TIMEOUT || '3600000', 10);
exports.DOWNLOAD_DIR = path.join(process.cwd(), `downloads_${exports.WORKER_NAME}`);
exports.MAX_CONCURRENT_TASKS = parseInt(process.env.MAX_CONCURRENT_TASKS || '10', 10);
// ==========================================
// 💰 定价配置 (每秒1积分，最低4s，最高15s)
// ==========================================
exports.PRICE_PER_SECOND = 1; // 每秒1积分
exports.MIN_DURATION = 4; // 最低4秒
exports.MAX_DURATION = 15; // 最高15秒
