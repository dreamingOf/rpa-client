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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const axios_1 = __importDefault(require("axios"));
const config = __importStar(require("./config"));
const logger_1 = require("./logger");
const concurrent_browser_engine_1 = require("./concurrent_browser_engine");
// ==========================================
// 🖥️ 总服务器通信
// ==========================================
async function fetchTask() {
    try {
        const url = `${config.TASK_SERVER_URL}${config.FETCH_TASK_ENDPOINT}`;
        const params = { worker: config.WORKER_NAME };
        logger_1.logger.info(`   🔍 fetch_task 请求: ${url} params=${JSON.stringify(params)}`);
        const resp = await axios_1.default.get(url, { params, timeout: 15000 });
        if (resp.status === 200) {
            const data = resp.data;
            logger_1.logger.info(`   📥 fetch_task 响应: ${JSON.stringify(data)}`);
            if (data.task) {
                const taskId = data.task.task_id || data.task.id || '?';
                logger_1.logger.info(`   ✅ fetch_task 成功: ${taskId}`);
                return data.task;
            }
            logger_1.logger.debug('   fetch_task: 服务器无待处理任务');
            return null;
        }
        else if (resp.status === 204) {
            logger_1.logger.info('   📥 fetch_task: 204 无任务');
            return null;
        }
        else {
            logger_1.logger.warn(`⚠️ 拉取任务异常: HTTP ${resp.status}`);
            return null;
        }
    }
    catch (e) {
        if (e.code === 'ECONNREFUSED') {
            logger_1.logger.warn('⚠️ 无法连接总服务器，稍后重试...');
        }
        else {
            logger_1.logger.error(`❌ 拉取任务失败: ${e}`);
        }
        return null;
    }
}
async function sendHeartbeat(status = 'online', vipCredit = null, nickname = null) {
    try {
        const url = `${config.TASK_SERVER_URL}/api/seedance/heartbeat`;
        const payload = {
            worker_name: config.WORKER_NAME,
            status
        };
        if (vipCredit !== null) {
            payload.vip_credit = vipCredit;
        }
        if (nickname !== null) {
            payload.nickname = nickname;
        }
        const resp = await axios_1.default.post(url, payload, { timeout: 10000 });
        if (resp.status === 200) {
            const data = resp.data;
            const taskCount = data.worker?.task_count || 0;
            logger_1.logger.info(`💓 心跳成功: ${config.WORKER_NAME} (${status}) 积分: ${vipCredit ?? '-'} 昵称: ${nickname ?? '-'}`);
            return true;
        }
        else {
            logger_1.logger.warn(`⚠️ 心跳异常: HTTP ${resp.status}`);
            return false;
        }
    }
    catch (e) {
        logger_1.logger.error(`❌ 心跳失败: ${e}`);
        return false;
    }
}
async function reportStatus(params) {
    try {
        const url = `${config.TASK_SERVER_URL}${config.CALLBACK_ENDPOINT}`;
        const payload = {
            task_id: params.taskId,
            status: params.status,
            worker: config.WORKER_NAME,
        };
        if (params.cosKey)
            payload.cos_key = params.cosKey;
        if (params.resultUrl)
            payload.result_url = params.resultUrl;
        if (params.fileSize)
            payload.file_size = params.fileSize;
        if (params.durationActual)
            payload.duration_actual = params.durationActual;
        if (params.errorMsg)
            payload.error_msg = params.errorMsg;
        if (params.externalTaskId)
            payload.external_task_id = params.externalTaskId;
        if (params.createdTime)
            payload.created_time = params.createdTime;
        if (params.forecastGenerateCost)
            payload.forecast_generate_cost = params.forecastGenerateCost;
        if (params.forecastQueueCost)
            payload.forecast_queue_cost = params.forecastQueueCost;
        if (params.antiCollisionTag)
            payload.anti_collision_tag = params.antiCollisionTag;
        const resp = await axios_1.default.post(url, payload, { timeout: 10000 });
        logger_1.logger.info(`📡 状态回报成功: ${params.taskId} -> ${params.status}`);
    }
    catch (e) {
        logger_1.logger.error(`❌ 状态回报失败: ${e}`);
    }
}
/**
 * 报告任务为待处理状态
 */
async function reportPending(taskId) {
    try {
        const url = `${config.TASK_SERVER_URL}/api/seedance/pending`;
        const payload = {
            task_id: taskId
        };
        logger_1.logger.info(`📡 发送待处理状态回报: ${taskId}`);
        logger_1.logger.info(`   📡 回报地址: ${url}`);
        logger_1.logger.info(`   📡 回报数据: ${JSON.stringify(payload)}`);
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        logger_1.logger.info(`   📡 回报响应状态: ${response.status} ${response.statusText}`);
        if (response.ok) {
            const responseBody = await response.text();
            logger_1.logger.info(`✅ 待处理状态回报成功: ${responseBody}`);
        }
        else {
            const errorText = await response.text();
            logger_1.logger.error(`❌ 待处理状态回报失败: ${response.status} ${errorText}`);
        }
    }
    catch (error) {
        logger_1.logger.error(`❌ 待处理状态回报异常: ${error}`);
    }
}
/**
 * 报告任务运行中状态
 */
async function reportRunning(taskId, externalTaskId, message, tag) {
    try {
        const url = `${config.TASK_SERVER_URL}${config.CALLBACK_ENDPOINT}`;
        const payload = {
            task_id: taskId,
            external_task_id: externalTaskId,
            status: 'running',
            worker: config.WORKER_NAME,
            message: message,
            anti_collision_tag: tag
        };
        logger_1.logger.info(`📡 发送运行中状态回报: ${taskId} -> ${externalTaskId}`);
        logger_1.logger.info(`   📝 状态信息: ${message}`);
        if (tag) {
            logger_1.logger.info(`   🏷️ 防串台标签: ${tag}`);
        }
        logger_1.logger.info(`   📡 回报地址: ${url}`);
        logger_1.logger.info(`   📡 回报数据: ${JSON.stringify(payload)}`);
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        logger_1.logger.info(`   📡 回报响应状态: ${response.status} ${response.statusText}`);
        if (response.ok) {
            const responseBody = await response.text();
            logger_1.logger.info(`✅ 运行中状态回报成功: ${responseBody}`);
        }
        else {
            const errorText = await response.text();
            logger_1.logger.error(`❌ 运行中状态回报失败: ${response.status} ${errorText}`);
        }
    }
    catch (error) {
        logger_1.logger.error(`❌ 运行中状态回报异常: ${error}`);
    }
}
// ==========================================
// 🎭 人格化调度系统 (反风控核心)
// ==========================================
class PersonaScheduler {
    schedule = config.SCHEDULE;
    behavior = config.BEHAVIOR;
    _today = null;
    _startHour = null;
    _endHour = null;
    _isWorkingToday = true;
    shouldWorkNow() {
        const now = new Date();
        const todayStr = now.toISOString().split('T')[0];
        if (this._today !== todayStr) {
            this._today = todayStr;
            this._decideTodaySchedule(now);
        }
        if (!this._isWorkingToday) {
            return false;
        }
        const currentHour = now.getHours() + now.getMinutes() / 60.0;
        if (this._startHour !== null && currentHour < this._startHour) {
            return false;
        }
        if (this._endHour !== null && currentHour > this._endHour) {
            return false;
        }
        // 午休检测 (12:00-13:30)
        if (currentHour >= 12.0 && currentHour <= 13.5) {
            if (Math.random() < this.schedule.lunch_break_prob) {
                return false;
            }
        }
        // 晚饭检测 (18:00-19:00)
        if (currentHour >= 18.0 && currentHour <= 19.0) {
            if (Math.random() < this.schedule.dinner_break_prob) {
                return false;
            }
        }
        return true;
    }
    _decideTodaySchedule(now) {
        const isWeekend = now.getDay() === 0 || now.getDay() === 6;
        if (isWeekend) {
            this._isWorkingToday = Math.random() < this.schedule.weekend_work_prob;
            if (this._isWorkingToday) {
                const startRange = this.schedule.weekend_start_hour;
                const endRange = this.schedule.weekend_end_hour;
                this._startHour = startRange[0] + Math.random() * (startRange[1] - startRange[0]);
                this._endHour = endRange[0] + Math.random() * (endRange[1] - endRange[0]);
                logger_1.logger.info(`📅 今天是周末，决定上班: ${this._startHour.toFixed(1)}h - ${this._endHour.toFixed(1)}h`);
            }
            else {
                logger_1.logger.info('📅 今天是周末，决定休息 🎉');
            }
        }
        else {
            this._isWorkingToday = true;
            const startRange = this.schedule.weekday_start_hour;
            const endRange = this.schedule.weekday_end_hour;
            this._startHour = startRange[0] + Math.random() * (startRange[1] - startRange[0]);
            this._endHour = endRange[0] + Math.random() * (endRange[1] - endRange[0]);
            logger_1.logger.info(`📅 工作日作息: ${this._startHour.toFixed(1)}h - ${this._endHour.toFixed(1)}h`);
        }
    }
    getTaskInterval() {
        // 小概率进入赶工模式
        if (Math.random() < this.behavior.burst_mode_prob) {
            const range = this.behavior.burst_interval_range;
            const interval = range[0] + Math.random() * (range[1] - range[0]);
            logger_1.logger.info(`🔥 赶工模式！间隔 ${interval.toFixed(0)}s`);
            return interval;
        }
        // 正常间隔
        const range = this.behavior.task_interval_range;
        let interval = range[0] + Math.random() * (range[1] - range[0]);
        // 小概率 AFK (摸鱼)
        if (Math.random() < this.behavior.random_afk_prob) {
            const afkTime = 300 + Math.random() * 600; // 5-15分钟
            logger_1.logger.info(`📱 摸鱼中... (${afkTime.toFixed(0)}s)`);
            return interval + afkTime;
        }
        return interval;
    }
    getSleepUntilWork() {
        const now = new Date();
        const currentHour = now.getHours() + now.getMinutes() / 60.0;
        if (this._startHour !== null && currentHour < this._startHour) {
            const deltaHours = this._startHour - currentHour;
            return deltaHours * 3600;
        }
        return 3600;
    }
}
// 当外部任务ID被提取时立即报告
async function reportExternalTaskId(taskId, externalTaskId, createTime, forecastGenerateCost, forecastQueueCost, antiCollisionTag) {
    try {
        const url = `${config.TASK_SERVER_URL}${config.CALLBACK_ENDPOINT}`;
        const payload = {
            task_id: taskId,
            status: 'processing', // 还是同一个状态就好
            worker: config.WORKER_NAME,
            external_task_id: externalTaskId // 直接包含外部任务ID
        };
        // 添加额外信息
        if (createTime !== null)
            payload.created_time = createTime;
        if (forecastGenerateCost !== null)
            payload.forecast_generate_cost = forecastGenerateCost;
        if (forecastQueueCost !== null)
            payload.forecast_queue_cost = forecastQueueCost;
        if (antiCollisionTag)
            payload.anti_collision_tag = antiCollisionTag;
        const resp = await axios_1.default.post(url, payload, { timeout: 10000 });
        if (resp.status === 200) {
            logger_1.logger.info(`📡 外部任务ID已回报: ${taskId} -> 外部ID ${externalTaskId}`);
        }
        else {
            logger_1.logger.warn(`⚠️ 外部任务ID回报异常: HTTP ${resp.status}`);
        }
    }
    catch (e) {
        logger_1.logger.error(`❌ 外部任务ID回报失败: ${e}`);
    }
}
/**
 * 报告视频URL获取结果
 */
async function reportVideoUrl(taskId, videoUrl, externalTaskId, tag) {
    try {
        const url = `${config.TASK_SERVER_URL}${config.CALLBACK_ENDPOINT}`;
        const payload = {
            task_id: taskId,
            status: 'completed', // 任务完成状态
            worker: config.WORKER_NAME,
            external_task_id: externalTaskId, // 外部任务ID
            video_url: videoUrl, // 视频URL
            anti_collision_tag: tag // 防串台标签
        };
        logger_1.logger.info(`📡 发送视频URL回报: ${taskId} -> ${videoUrl.substring(0, 100)}...`);
        logger_1.logger.info(`   📡 外部任务ID: ${externalTaskId}`);
        if (tag) {
            logger_1.logger.info(`   🏷️ 防串台标签: ${tag}`);
        }
        logger_1.logger.info(`   📡 回报地址: ${url}`);
        logger_1.logger.info(`   📡 回报数据: ${JSON.stringify(payload)}`);
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        logger_1.logger.info(`   📡 回报响应状态: ${response.status} ${response.statusText}`);
        if (response.ok) {
            const responseBody = await response.text();
            logger_1.logger.info(`✅ 视频URL已回报: ${taskId} -> ${externalTaskId}`);
            logger_1.logger.info(`   📡 回报响应内容: ${responseBody.substring(0, 200)}...`);
        }
        else {
            const errorBody = await response.text();
            logger_1.logger.error(`❌ 视频URL回报失败: ${response.status} ${response.statusText}`);
            logger_1.logger.error(`   📡 错误响应内容: ${errorBody.substring(0, 200)}...`);
        }
    }
    catch (e) {
        logger_1.logger.error(`❌ 视频URL回报异常: ${e}`);
        logger_1.logger.error(`   📡 异常详情: ${JSON.stringify(e, Object.getOwnPropertyNames(e))}`);
    }
}
/**
 * 报告视频生成错误
 */
async function reportVideoError(taskId, itemId, errorMsg, tag) {
    try {
        const url = `${config.TASK_SERVER_URL}${config.CALLBACK_ENDPOINT}`;
        const payload = {
            task_id: taskId,
            status: 'failed_generation', // 任务失败状态
            worker: config.WORKER_NAME,
            external_task_id: itemId, // 使用项目ID作为外部任务ID
            error_msg: errorMsg, // 错误信息
            anti_collision_tag: tag // 防串台标签
        };
        logger_1.logger.info(`📡 发送视频错误回报: ${taskId} -> ${itemId}`);
        logger_1.logger.info(`   📝 错误信息: ${errorMsg.substring(0, 100)}...`);
        if (tag) {
            logger_1.logger.info(`   🏷️ 防串台标签: ${tag}`);
        }
        logger_1.logger.info(`   📡 回报地址: ${url}`);
        logger_1.logger.info(`   📡 回报数据: ${JSON.stringify(payload)}`);
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        logger_1.logger.info(`   📡 回报响应状态: ${response.status} ${response.statusText}`);
        if (response.ok) {
            const responseBody = await response.text();
            logger_1.logger.info(`✅ 视频错误已回报: ${taskId} -> ${itemId}`);
            logger_1.logger.info(`   📡 回报响应内容: ${responseBody.substring(0, 200)}...`);
        }
        else {
            const errorBody = await response.text();
            logger_1.logger.error(`❌ 视频错误回报失败: ${response.status} ${response.statusText}`);
            logger_1.logger.error(`   📡 错误响应内容: ${errorBody.substring(0, 200)}...`);
        }
    }
    catch (e) {
        logger_1.logger.error(`❌ 视频错误回报异常: ${e}`);
        logger_1.logger.error(`   📡 异常详情: ${JSON.stringify(e, Object.getOwnPropertyNames(e))}`);
    }
}
function handleCompletedTasks(completedResults) {
    for (const result of completedResults) {
        const taskId = result.task_id;
        const videoUrl = result.video_path; // 现在是URL而非本地路径
        const status = result.status;
        const taskInfo = result.task_info || {};
        const durationActual = taskInfo.duration || undefined;
        // 获取外部任务ID（优先使用从API响应中提取的，其次使用原始任务信息中的）
        let externalTaskId = '';
        // 获取防串台标签
        let antiCollisionTag = '';
        if (result.antiCollisionTag) {
            antiCollisionTag = result.antiCollisionTag;
            logger_1.logger.info(`🏷️ [${taskId}] 防串台标签: ${antiCollisionTag}`);
        }
        // 尝试从task_info中获取原始外部任务ID
        if (taskInfo && typeof taskInfo === 'object') {
            externalTaskId = taskInfo.external_task_id || '';
        }
        // 从completed result中获取从API响应中提取的外部任务ID
        if (result.externalTaskId) {
            externalTaskId = result.externalTaskId;
        }
        if (externalTaskId) {
            logger_1.logger.info(`🏷️ [${taskId}] 外部任务ID: ${externalTaskId}`);
        }
        // 处理generate响应完成的情况（不需要再次回报）
        if (status === 'generate_processed') {
            logger_1.logger.info(`✅ [${taskId}] generate响应已处理，槽位已释放 (外部ID: ${externalTaskId || '无'}, 防串台标签: ${antiCollisionTag || '无'})`);
            // 继续正常处理，但不需要再次回报状态
        }
        // 处理运行中的任务状态回调（来自asset_list监听）
        if (status === 'failed_generation' && result.error_msg && result.error_msg.includes('正在执行中')) {
            logger_1.logger.info(`⏳ [${taskId}] 任务运行中状态已记录，不重复回报 (外部ID: ${externalTaskId || '无'})`);
            // 运行中状态不需要再次回报，仅记录日志
            return;
        }
        if (videoUrl) {
            logger_1.logger.info(`🔗 [${taskId}] 视频URL: ${videoUrl.substring(0, 80)}...`);
            reportStatus({
                taskId,
                status: 'completed',
                resultUrl: videoUrl,
                durationActual,
                externalTaskId,
                antiCollisionTag
            });
            logger_1.logger.info(`✅ [${taskId}] 任务完成！URL已回报 (外部ID: ${externalTaskId || '无'}, 防串台标签: ${antiCollisionTag || '无'})`);
        }
        else {
            const errorMsg = result.error_msg || `生成失败: ${status}`;
            reportStatus({
                taskId,
                status,
                errorMsg,
                externalTaskId,
                antiCollisionTag
            });
            logger_1.logger.error(`❌ [${taskId}] 生成失败 (${status}): ${errorMsg} (外部ID: ${externalTaskId || '无'}, 防串台标签: ${antiCollisionTag || '无'})`);
        }
    }
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
async function main() {
    logger_1.logger.info(`🚀 SeeDance Worker [${config.WORKER_NAME}] 启动中...`);
    logger_1.logger.info(`🔢 最大并发: ${config.MAX_CONCURRENT_TASKS}`);
    // 确保下载目录存在
    fs.mkdirSync(config.DOWNLOAD_DIR, { recursive: true });
    logger_1.logger.info(`📁 下载目录: ${config.DOWNLOAD_DIR} (已确认存在)`);
    // 启动时发送心跳注册
    await sendHeartbeat('online');
    const engine = new concurrent_browser_engine_1.ConcurrentBrowserEngine();
    const scheduler = new PersonaScheduler();
    // 用于在回调中更新 lastHeartbeat
    let lastHeartbeat = Date.now();
    try {
        await engine.start();
        // 设置积分拦截回调：拦截到积分时立即发送心跳 (必须在 login 之前设置)
        engine.onCreditUpdate(async (credit) => {
            logger_1.logger.info(`📤 积分更新，立即发送心跳: ${credit}`);
            await sendHeartbeat('online', credit, engine.getOwnerName());
            lastHeartbeat = Date.now();
        });
        // 设置昵称拦截回调：拦截到昵称时立即发送心跳
        engine.onOwnerNameUpdate(async (ownerName) => {
            logger_1.logger.info(`👤 昵称更新，立即发送心跳: ${ownerName}`);
            await sendHeartbeat('online', engine.getVipCredit(), ownerName);
            lastHeartbeat = Date.now();
        });
        // 设置外部任务ID接收回调：当外部任务ID被提取时立即报告
        engine.onExternalTaskIdReceived(async (taskId, externalTaskId, createTime, forecastGenerateCost, forecastQueueCost, antiCollisionTag) => {
            logger_1.logger.info(`📥 捕获到外部任务ID: ${taskId} -> ${externalTaskId}`);
            logger_1.logger.info(`   📅 创建时间: ${createTime}`);
            logger_1.logger.info(`   ⏱️ 预计生成时长: ${forecastGenerateCost}`);
            logger_1.logger.info(`   ⏳ 预计等待时长: ${forecastQueueCost}`);
            if (antiCollisionTag) {
                logger_1.logger.info(`   🏷️ 防串台标签: ${antiCollisionTag}`);
            }
            await reportExternalTaskId(taskId, externalTaskId, createTime, forecastGenerateCost, forecastQueueCost, antiCollisionTag);
        });
        // 设置视频URL接收回调：当获取到视频URL时立即报告
        engine.onVideoUrlReceived(async (taskId, videoUrl, externalTaskId, tag) => {
            logger_1.logger.info(`📥 捕获到视频URL: ${taskId} -> ${videoUrl.substring(0, 100)}...`);
            logger_1.logger.info(`   📡 外部任务ID: ${externalTaskId}`);
            if (tag) {
                logger_1.logger.info(`   🏷️ 防串台标签: ${tag}`);
            }
            // 报告视频URL获取结果
            await reportVideoUrl(taskId, videoUrl, externalTaskId, tag);
        });
        // 设置视频错误接收回调：当获取到视频生成错误时立即报告
        engine.onVideoErrorReceived(async (taskId, itemId, errorMsg, tag) => {
            logger_1.logger.error(`❌ 捕获到视频生成错误: ${taskId} -> 项目ID: ${itemId}`);
            logger_1.logger.error(`   📝 错误信息: ${errorMsg}`);
            if (tag) {
                logger_1.logger.error(`   🏷️ 关联标签: ${tag}`);
                // 如果是来自asset_list的标签，尝试关联到对应的任务槽位
                if (taskId === 'asset_list') {
                    // 验证标签格式
                    const isValid = /^[a-f0-9]{8}$/.test(tag);
                    if (isValid) {
                        const slot = engine.findSlotByTag(tag);
                        if (slot) {
                            logger_1.logger.error(`   🔗 防串台标签关联到任务槽位: ${slot.taskId} <- ${tag}`);
                            // 可以在这里更新任务信息或进行其他处理
                        }
                        else {
                            logger_1.logger.error(`   ⚠️ 未找到对应的任务槽位: ${tag}`);
                        }
                    }
                    else {
                        logger_1.logger.warn(`   ⚠️ 标签格式无效: ${tag}`);
                    }
                }
            }
            // 如果是高峰期错误，回报待处理状态
            if (errorMsg.includes("高峰期限制")) {
                await reportPending(taskId);
            }
            else {
                // 报告视频生成错误
                await reportVideoError(taskId, itemId, errorMsg, tag);
            }
        });
        // 设置视频状态接收回调：当获取到视频状态更新时处理
        engine.onVideoStatusReceived(async (taskId, itemId, status, message, tag) => {
            logger_1.logger.info(`📥 捕获到视频状态更新: ${taskId} -> 项目ID: ${itemId}, 状态: ${status}`);
            logger_1.logger.info(`   📝 状态信息: ${message}`);
            logger_1.logger.info(`📞 状态回调已触发，参数数量: ${arguments.length}`);
            if (tag) {
                logger_1.logger.info(`   🏷️ 关联标签: ${tag}`);
                // 如果是来自asset_list的标签，尝试关联到对应的任务槽位
                if (taskId === 'asset_list') {
                    // 验证标签格式
                    const isValid = /^[a-f0-9]{8}$/.test(tag);
                    if (isValid) {
                        const slot = engine.findSlotByTag(tag);
                        if (slot) {
                            logger_1.logger.info(`   🔗 防串台标签关联到任务槽位: ${slot.taskId} <- ${tag}`);
                            // 可以在这里更新任务信息或进行其他处理
                        }
                        else {
                            logger_1.logger.info(`   ⚠️ 未找到对应的任务槽位: ${tag}`);
                        }
                    }
                    else {
                        logger_1.logger.warn(`   ⚠️ 标签格式无效: ${tag}`);
                    }
                }
            }
            else {
                logger_1.logger.info(`   📝 无标签信息`);
            }
            // 根据状态进行相应处理
            if (status === 'running') {
                logger_1.logger.info(`   ⏳ 任务正在执行中，回报运行中状态`);
                // 回报运行中状态给服务端
                await reportRunning(taskId, itemId, message, tag);
            }
            else {
                logger_1.logger.info(`   📊 其他状态: ${status}`);
            }
        });
        logger_1.logger.info(`✅ 视频状态回调设置完成`);
        // 设置防串台标签接收回调：当获取到防串台标签时立即记录和处理
        engine.onAntiCollisionTagReceived((taskId, tag) => {
            logger_1.logger.info(`📥 捕获到防串台标签: ${taskId} -> ${tag}`);
            // 如果是来自asset_list的标签，尝试关联到对应的任务槽位
            if (taskId === 'asset_list') {
                // 现在tag已经是8位字符内容，不需要再提取
                const tagContent = tag;
                // 验证标签格式
                const isValid = /^[a-f0-9]{8}$/.test(tagContent);
                if (!isValid) {
                    logger_1.logger.warn(`   ⚠️ 标签格式无效: ${tagContent}`);
                    return;
                }
                // 尝试通过标签找到对应的任务槽位
                const slot = engine.findSlotByTag(tagContent);
                if (slot) {
                    logger_1.logger.info(`   🔗 防串台标签关联到任务槽位: ${slot.taskId} <- ${tagContent}`);
                    // 可以在这里更新任务信息或进行其他处理
                }
                else {
                    logger_1.logger.info(`   ⚠️ 未找到对应的任务槽位: ${tagContent}`);
                }
                // 可以选择将标签信息回报给服务器
                // 这里暂时只做日志记录
            }
            else {
                // 来自其他来源的标签（如generate监听器）
                logger_1.logger.info(`   📝 来自其他来源的标签: ${taskId} -> ${tag}`);
            }
        });
        await engine.login();
        logger_1.logger.info(`✅ 浏览器就绪，进入并发工作循环 (${engine.getStatusSummary()})`);
        let consecutiveEmpty = 0;
        let pollCount = 0;
        let lastMainPageRefresh = Date.now(); // 记录上次刷新主页面时间
        while (true) {
            pollCount++;
            // 每 30 秒发送一次心跳 (携带拦截到的积分和昵称)
            if (Date.now() - lastHeartbeat > 30000) {
                const vipCredit = engine.getVipCredit();
                const ownerName = engine.getOwnerName();
                await sendHeartbeat('online', vipCredit, ownerName);
                lastHeartbeat = Date.now();
            }
            // 每 60 秒刷新一次主页面
            if (Date.now() - lastMainPageRefresh > 60000) {
                logger_1.logger.info('🔄 定时刷新主页面...');
                await engine.refreshMainPage();
                lastMainPageRefresh = Date.now();
            }
            // === 1. 轮询已完成的任务 ===
            const completed = await engine.pollActiveSlots();
            if (completed.length > 0) {
                handleCompletedTasks(completed);
            }
            // === 2. 获取新任务 ===
            let fetchedAny = false;
            if (engine.hasFreeSlot()) {
                // 检查是否在全局冷静期
                if (engine.isInGlobalCooldown()) {
                    const remaining = engine.getGlobalCooldownRemaining();
                    logger_1.logger.info(`🌍️ 全局冷静期中，剩余 ${remaining} 秒，跳过任务获取`);
                    await sleep(5000);
                    continue;
                }
                let fetchMiss = 0;
                while (engine.hasFreeSlot()) {
                    const task = await fetchTask();
                    if (!task) {
                        fetchMiss++;
                        if (fetchMiss >= 3) {
                            break; // 连续 3 次空拉才放弃
                        }
                        const freeSlots = config.MAX_CONCURRENT_TASKS - engine.activeCount();
                        logger_1.logger.info(`   🔄 空拉第${fetchMiss}次，3秒后重试... (空闲槽: ${freeSlots})`);
                        await sleep(3000);
                        continue;
                    }
                    fetchedAny = true;
                    consecutiveEmpty = 0;
                    const taskId = task.task_id || task.id || '';
                    const prompt = task.prompt || '';
                    const duration = task.duration || 10;
                    const ratio = task.ratio || '16:9';
                    logger_1.logger.info(`📋 收到任务 ${taskId}: ${prompt.substring(0, 50)}... (${duration}s, ${ratio})`);
                    // 回报: 开始处理
                    await reportStatus({ taskId, status: 'processing' });
                    // 提交到并发槽位
                    const success = await engine.submitTask(task);
                    if (!success) {
                        await reportStatus({ taskId, status: 'failed_generation' });
                        logger_1.logger.error(`❌ [${taskId}] 提交到槽位失败`);
                    }
                }
            }
            if (!fetchedAny && engine.hasFreeSlot()) {
                consecutiveEmpty++;
            }
            // === 3. 定期输出状态 ===
            if (pollCount % 6 === 0 && engine.activeCount() > 0) {
                logger_1.logger.info(`📊 ${engine.getStatusSummary()}`);
            }
            // === 4. 等待下次轮询 ===
            if (engine.activeCount() > 0) {
                await sleep(10000);
            }
            else {
                let pollInterval = Math.min(10 + consecutiveEmpty * 5, 60);
                pollInterval += (Math.random() - 0.5) * 6;
                pollInterval = Math.max(5, pollInterval);
                if (consecutiveEmpty % 10 === 1) {
                    logger_1.logger.info(`💤 无任务，轮询间隔 ${pollInterval.toFixed(0)}s (连续空 ${consecutiveEmpty} 次)`);
                }
                await sleep(pollInterval * 1000);
            }
        }
    }
    catch (e) {
        if (e.message === 'SIGINT') {
            logger_1.logger.info('🛑 收到停止信号，Worker 正在关闭...');
            if (engine.activeCount() > 0) {
                logger_1.logger.warn(`⚠️ 还有 ${engine.activeCount()} 个任务正在生成，将被中断`);
            }
        }
        else {
            logger_1.logger.error(`❌ Worker 致命错误: ${e}`);
            console.error(e);
        }
    }
    finally {
        await sendHeartbeat('offline');
        await engine.stop();
        logger_1.logger.info(`👋 Worker [${config.WORKER_NAME}] 已停止`);
    }
}
// 处理进程退出信号
process.on('SIGINT', () => {
    logger_1.logger.info('🛑 收到 SIGINT 信号...');
    process.exit(0);
});
process.on('SIGTERM', () => {
    logger_1.logger.info('🛑 收到 SIGTERM 信号...');
    process.exit(0);
});
// 启动
main().catch(e => {
    logger_1.logger.error(`❌ 启动失败: ${e}`);
    process.exit(1);
});
