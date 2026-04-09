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
exports.BrowserEngine = exports.TaskSlot = void 0;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const playwright_1 = require("playwright");
const uuid_1 = require("uuid");
const axios_1 = __importDefault(require("axios"));
const config = __importStar(require("./config"));
const logger_1 = require("./logger");
/**
 * 获取图片尺寸
 * 支持 PNG, JPEG, GIF, WebP 格式
 */
function getImageDimensions(buffer) {
    // PNG: 前8个字节是签名，然后是 IHDR chunk
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
        // PNG signature: 89 50 4E 47 0D 0A 1A 0A
        // IHDR starts at byte 8
        const width = buffer.readUInt32BE(16);
        const height = buffer.readUInt32BE(20);
        return { width, height };
    }
    // JPEG: FF D8 (SOI)
    if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
        let pos = 2;
        while (pos < buffer.length) {
            const marker = buffer.readUInt16BE(pos);
            pos += 2;
            if (marker === 0xFFC0 || marker === 0xFFC2) {
                // SOF0 or SOF2 (baseline or progressive DCT)
                pos += 3; // skip marker length and precision
                const height = buffer.readUInt16BE(pos);
                pos += 2;
                const width = buffer.readUInt16BE(pos);
                return { width, height };
            }
            // Skip to next marker
            const length = buffer.readUInt16BE(pos);
            pos += length;
        }
    }
    // GIF: GIF87a or GIF89a
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
        const width = buffer.readUInt16LE(6);
        const height = buffer.readUInt16LE(8);
        return { width, height };
    }
    // WebP: RIFF....WEBP
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
        buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
        // Simple VP8X or VP8
        const chunkStart = 12;
        const chunk = buffer.subarray(chunkStart, chunkStart + 4).toString();
        if (chunk === 'VP8X') {
            // Extended WebP
            const width = (buffer.readUInt8(24) << 16) | (buffer.readUInt8(25) << 8) | buffer.readUInt8(26);
            const height = (buffer.readUInt8(27) << 16) | (buffer.readUInt8(28) << 8) | buffer.readUInt8(29);
            return { width: width + 1, height: height + 1 };
        }
        else if (chunk === 'VP8 ') {
            // Simple WebP
            const width = buffer.readUInt16LE(26) & 0x3FFF;
            const height = buffer.readUInt16LE(28) & 0x3FFF;
            return { width, height };
        }
    }
    return null;
}
// 防串台: 最小生成时间 (秒)
const MIN_GEN_SECONDS = 60;
/**
 * 纯 JS 读取 mp4 文件的 moov/mvhd atom 获取视频时长 (秒)
 */
function getMp4Duration(filepath) {
    try {
        const buffer = fs.readFileSync(filepath);
        const fileSize = buffer.length;
        let pos = 0;
        while (pos < fileSize - 8) {
            const size = buffer.readUInt32BE(pos);
            const atomType = buffer.slice(pos + 4, pos + 8).toString('ascii');
            if (size < 8)
                break;
            if (atomType === 'moov') {
                const moovData = buffer.slice(pos + 8, pos + Math.min(size, 10 * 1024 * 1024));
                let subPos = 0;
                while (subPos < moovData.length - 8) {
                    const subSize = moovData.readUInt32BE(subPos);
                    const subType = moovData.slice(subPos + 4, subPos + 8).toString('ascii');
                    if (subSize < 8)
                        break;
                    if (subType === 'mvhd') {
                        const version = moovData[subPos + 8];
                        let timescale, duration;
                        if (version === 0) {
                            timescale = moovData.readUInt32BE(subPos + 20);
                            duration = moovData.readUInt32BE(subPos + 24);
                        }
                        else {
                            timescale = moovData.readUInt32BE(subPos + 28);
                            duration = Number(moovData.readBigUInt64BE(subPos + 32));
                        }
                        if (timescale > 0) {
                            return duration / timescale;
                        }
                        return 0;
                    }
                    subPos += subSize;
                }
                break;
            }
            pos += size;
        }
    }
    catch (e) {
        // ignore
    }
    return 0;
}
/**
 * 验证下载的视频文件是否为真实的 Seedance 生成结果
 */
function validateVideo(filepath, expectedDurationSec = 5) {
    try {
        const fileSize = fs.statSync(filepath).size;
        if (fileSize < 500000) {
            logger_1.logger.warn(`   ❌ 视频验证失败: 文件太小 (${(fileSize / 1024).toFixed(0)}KB < 500KB)`);
            return false;
        }
        const duration = getMp4Duration(filepath);
        const minDuration = Math.max(3.0, expectedDurationSec * 0.7);
        if (duration < minDuration) {
            logger_1.logger.warn(`   ❌ 视频验证失败: 时长 ${duration.toFixed(1)}s < ${minDuration.toFixed(1)}s (预期${expectedDurationSec}s), 可能是生成动画预览`);
            return false;
        }
        logger_1.logger.info(`   ✅ 视频验证通过: ${(fileSize / 1024 / 1024).toFixed(1)}MB, 时长 ${duration.toFixed(1)}s (预期${expectedDurationSec}s)`);
        return true;
    }
    catch (e) {
        logger_1.logger.warn(`   ⚠️ 视频验证异常: ${e}, 放行文件`);
        return true;
    }
}
// 工具函数
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
function randomUniform(min, max) {
    return Math.random() * (max - min) + min;
}
function randomGauss(mean, stddev) {
    const u1 = Math.random();
    const u2 = Math.random();
    const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    return z0 * stddev + mean;
}
// 任务槽位
class TaskSlot {
    page;
    taskInfo;
    taskId;
    externalTaskId = ''; // 外部任务ID
    createdTime = null; // 外部创建时间
    forecastGenerateCost = null; // 预计生成时长
    forecastQueueCost = null; // 预计等待时长
    state = 'generating';
    startTime = Date.now();
    oldDoneCount = 0;
    oldVideoUrls = new Set();
    generationConfirmed = false;
    tag = '';
    _lastDebug;
    lastNetworkAt = Date.now();
    lastRefreshAt = 0;
    _waitingForVideoUrl = false; // 是否正在等待视频URL
    _videoUrlReceived = false; // 是否已收到视频URL
    _videoUrlProcessed = false; // 视频URL是否已处理完成
    _generateProcessed = false; // generate响应是否已处理完成
    constructor(page, taskInfo) {
        this.page = page;
        this.taskInfo = taskInfo;
        this.taskId = taskInfo.task_id || taskInfo.id || '';
        this.externalTaskId = taskInfo.external_task_id || '';
    }
}
exports.TaskSlot = TaskSlot;
/**
 * 浏览器引擎 - 控制即梦视频生成
 */
class BrowserEngine {
    playwright = null;
    browser = null;
    context = null;
    page = null;
    _mainPage = null;
    userDataDir;
    _vipCredit = null;
    _ownerName = null; // 用户昵称
    _onCreditUpdate = null;
    _onOwnerNameUpdate = null; // 昵称更新回调
    _activeTaskSlots = new Map(); // 用于标签匹配的任务槽位映射
    _completedTaskPages = new Set(); // 已完成任务但未关闭的页面
    _onExternalTaskIdReceived = null; // 外部任务ID接收回调
    _onVideoUrlReceived = null; // 视频URL接收回调
    _onVideoErrorReceived = null; // 视频错误接收回调
    _onAntiCollisionTagReceived = null; // 防串台标签接收回调
    _onVideoStatusReceived = null; // 视频状态接收回调
    _assetTaskStateByExternalId = new Map(); // external_task_id -> 资产状态
    constructor() {
        this.userDataDir = path.join(process.cwd(), `user_data_${config.WORKER_NAME}`);
        fs.mkdirSync(this.userDataDir, { recursive: true });
        fs.mkdirSync(config.DOWNLOAD_DIR, { recursive: true });
    }
    /**
     * 获取最新的 VIP 积分 (从网络请求拦截)
     */
    getVipCredit() {
        return this._vipCredit;
    }
    /**
     * 获取用户昵称
     */
    getOwnerName() {
        return this._ownerName;
    }
    /**
     * 设置积分更新回调 (拦截到积分时立即调用)
     */
    onCreditUpdate(callback) {
        this._onCreditUpdate = callback;
    }
    /**
     * 设置昵称更新回调 (拦截到昵称时立即调用)
     */
    onOwnerNameUpdate(callback) {
        this._onOwnerNameUpdate = callback;
    }
    /**
     * 设置外部任务ID接收回调
     */
    onExternalTaskIdReceived(callback) {
        this._onExternalTaskIdReceived = callback;
    }
    /**
     * 设置视频URL接收回调
     */
    onVideoUrlReceived(callback) {
        this._onVideoUrlReceived = callback;
    }
    /**
     * 设置视频状态接收回调
     */
    onVideoStatusReceived(callback) {
        this._onVideoStatusReceived = callback;
    }
    /**
     * 设置视频错误接收回调
     */
    onVideoErrorReceived(callback) {
        this._onVideoErrorReceived = callback;
    }
    /**
     * 设置防串台标签接收回调
     */
    onAntiCollisionTagReceived(callback) {
        this._onAntiCollisionTagReceived = callback;
    }
    /**
     * 设置页面的网络响应监听器，拦截 user_credit 请求
     */
    _setupCreditListener(page) {
        page.on('response', async (response) => {
            try {
                const url = response.url();
                if (url.includes('/commerce/v1/benefits/user_credit')) {
                    const json = await response.json();
                    const vipCredit = json?.data?.credit?.vip_credit;
                    if (typeof vipCredit === 'number') {
                        this._vipCredit = vipCredit;
                        logger_1.logger.info(`💎 拦截到 VIP 积分: ${vipCredit}`);
                        if (this._onCreditUpdate) {
                            this._onCreditUpdate(vipCredit);
                        }
                    }
                }
            }
            catch (e) {
                logger_1.logger.warn(`⚠️ 积分监听异常: ${e}`);
            }
        });
    }
    /**
     * 设置页面的网络响应监听器，拦截工作空间信息请求
     */
    _setupWorkspaceListener(page) {
        page.on('response', async (response) => {
            try {
                const url = response.url();
                if (url.includes('/cc/v1/workspace/get_user_workspaces')) {
                    const json = await response.json();
                    const ownerName = json?.data?.workspace_infos?.[0]?.owner_name;
                    if (ownerName && ownerName !== this._ownerName) {
                        this._ownerName = ownerName;
                        logger_1.logger.info(`👤 拦截到用户昵称: ${ownerName}`);
                        if (this._onOwnerNameUpdate) {
                            this._onOwnerNameUpdate(ownerName);
                        }
                    }
                }
            }
            catch (e) {
                logger_1.logger.warn(`⚠️ 工作空间监听异常: ${e}`);
            }
        });
    }
    /**
     * 设置页面的生成请求监听器，拦截 aigc_draft/generate 响应
     */
    _setupGenerateListener(page) {
        logger_1.logger.info('📡 开始设置生成请求监听器');
        page.on('response', async (response) => {
            try {
                const url = response.url();
                // 记录所有可能的API请求用于调试
                const isGenerateRequest = url.includes('/aigc_draft') ||
                    url.includes('/generate') ||
                    url.includes('/mweb') && url.includes('draft');
                if (isGenerateRequest) {
                    logger_1.logger.info(`🎯 拦截到生成相关请求响应: ${url}`);
                    logger_1.logger.info(`   状态码: ${response.status()}, Headers: ${JSON.stringify(Object.keys(response.headers()))}`);
                    const json = await response.json();
                    // 记录完整响应数据用于调试
                    logger_1.logger.info(`   响应数据: ${JSON.stringify(json, null, 2)}`);
                    // 获取当前页面的标签信息
                    logger_1.logger.info(`🔍 开始获取页面标签...`);
                    const currentPageTag = await this._getPageTag(page);
                    logger_1.logger.info(`🔍 页面标签获取结果: ${currentPageTag || 'null'}`);
                    if (currentPageTag) {
                        logger_1.logger.info(`   🏷️ 当前页面标签: ${currentPageTag}`);
                        // 根据标签精确匹配任务槽位
                        logger_1.logger.info(`🔍 开始查找标签 ${currentPageTag} 对应的任务槽位...`);
                        const slot = this._findSlotByTag(currentPageTag);
                        logger_1.logger.info(`🔍 任务槽位查找结果: ${slot ? '找到' : '未找到'}`);
                        // 尝试从响应中提取任务ID和额外信息（无论标签匹配是否成功）
                        const responseInfo = this._extractTaskIdFromResponse(json, currentPageTag);
                        const externalTaskId = responseInfo.externalTaskId;
                        logger_1.logger.info(`🔍 任务ID提取结果: ${externalTaskId || 'null'}`);
                        logger_1.logger.info(`   📅 创建时间: ${responseInfo.createdTime}`);
                        logger_1.logger.info(`   ⏱️ 预计生成时长: ${responseInfo.forecastGenerateCost}`);
                        logger_1.logger.info(`   ⏳ 预计等待时长: ${responseInfo.forecastQueueCost}`);
                        if (externalTaskId) {
                            if (slot) {
                                // 标签匹配成功的情况
                                slot.externalTaskId = externalTaskId;
                                slot.createdTime = responseInfo.createdTime;
                                slot.forecastGenerateCost = responseInfo.forecastGenerateCost;
                                slot.forecastQueueCost = responseInfo.forecastQueueCost;
                                slot.lastNetworkAt = Date.now();
                                logger_1.logger.info(`   ✅ 标签匹配成功: ${currentPageTag} -> 外部任务ID ${externalTaskId}`);
                                // 调用外部任务ID接收回调（同时带上防串台标签）
                                if (this._onExternalTaskIdReceived) {
                                    this._onExternalTaskIdReceived(slot.taskId, externalTaskId, responseInfo.createdTime, responseInfo.forecastGenerateCost, responseInfo.forecastQueueCost, currentPageTag);
                                }
                                // 同时回调防串台标签（保留原有回调）
                                if (currentPageTag && this._onAntiCollisionTagReceived) {
                                    this._onAntiCollisionTagReceived(slot.taskId, currentPageTag);
                                }
                                // 监听到generate响应并回报后，直接标记槽位为完成状态
                                logger_1.logger.info(`✅ [${slot.taskId}] generate响应已处理，标记槽位完成`);
                                slot._generateProcessed = true;
                                slot._videoUrlProcessed = true; // 标记为已处理，避免后续重复处理
                                slot.lastNetworkAt = Date.now();
                            }
                            else {
                                // 标签匹配失败但仍提取到外部ID的情况
                                logger_1.logger.warn(`   ⚠️ 标签匹配失败，但成功提取外部任务ID: ${externalTaskId}`);
                                logger_1.logger.info(`   📊 当前活动槽位数量: ${this._activeTaskSlots.size}, 标签列表: ${Array.from(this._activeTaskSlots.keys()).join(',')}`);
                                logger_1.logger.info(`   📊 当前活动槽位详情: ${Array.from(this._activeTaskSlots.entries()).map(([tag, slot]) => `${tag}:${slot.taskId}`).join('; ')}`);
                                // 尝试通过页面匹配找到任务槽位
                                const pageSlot = this._findSlotByPage(page);
                                if (pageSlot) {
                                    logger_1.logger.info(`   🔄 通过页面匹配找到任务槽位: ${pageSlot.taskId}`);
                                    pageSlot.externalTaskId = externalTaskId;
                                    pageSlot.createdTime = responseInfo.createdTime;
                                    pageSlot.forecastGenerateCost = responseInfo.forecastGenerateCost;
                                    pageSlot.forecastQueueCost = responseInfo.forecastQueueCost;
                                    pageSlot.lastNetworkAt = Date.now();
                                    if (this._onExternalTaskIdReceived) {
                                        this._onExternalTaskIdReceived(pageSlot.taskId, externalTaskId, responseInfo.createdTime, responseInfo.forecastGenerateCost, responseInfo.forecastQueueCost, currentPageTag);
                                    }
                                    // 同时回调防串台标签（保留原有回调）
                                    if (currentPageTag && this._onAntiCollisionTagReceived) {
                                        this._onAntiCollisionTagReceived(pageSlot.taskId, currentPageTag);
                                    }
                                    // 监听到generate响应并回报后，直接标记槽位为完成状态
                                    logger_1.logger.info(`✅ [${pageSlot.taskId}] generate响应已处理（页面匹配），标记槽位完成`);
                                    pageSlot._generateProcessed = true;
                                    pageSlot._videoUrlProcessed = true;
                                    pageSlot.lastNetworkAt = Date.now();
                                }
                                else {
                                    logger_1.logger.warn(`   ❌ 无法通过页面匹配找到任务槽位，外部ID ${externalTaskId} 无法关联到具体任务`);
                                }
                            }
                        }
                        else {
                            // 无法提取任务ID的情况
                            logger_1.logger.warn(`   ⚠️ 无法从响应中提取任务ID`);
                            logger_1.logger.info(`   📤 响应JSON: ${JSON.stringify(json, null, 2).substring(0, 500)}...`);
                            // 检查是否是高峰期错误
                            const isPeakHourError = json.ret === "1310" ||
                                json.fail_starling_key === "exceed_model_parallel_max" ||
                                (json.errmsg && json.errmsg.includes("使用高峰期"));
                            if (isPeakHourError) {
                                logger_1.logger.error(`🚨 检测到高峰期错误，触发全局冷静机制`);
                                logger_1.logger.error(`   错误信息: ${json.errmsg}`);
                                // 设置全局冷静5分钟
                                this.setGlobalCooldown?.(5);
                                // 如果有槽位信息，回报待处理状态
                                if (slot) {
                                    logger_1.logger.warn(`📡 将任务 ${slot.taskId} 标记为待处理状态`);
                                    if (this._onVideoErrorReceived) {
                                        this._onVideoErrorReceived(slot.taskId, slot.taskId, "高峰期限制，任务转为待处理");
                                    }
                                }
                            }
                            if (!slot) {
                                logger_1.logger.warn(`   ⚠️ 标签匹配失败且无法提取任务ID`);
                            }
                        }
                    }
                    else {
                        logger_1.logger.warn(`   ⚠️ 无法获取当前页面标签`);
                        // 检查页面上的所有文本内容，看是否能找到标签
                        try {
                            const allText = await page.evaluate(() => document.body.textContent || '');
                            const possibleTags = allText.match(/⟨⟩⟨([a-zA-Z0-9]{8})⟩/g) || [];
                            logger_1.logger.info(`   🔍 页面中可能存在的标签: ${possibleTags.join(', ')}`);
                        }
                        catch (e) {
                            logger_1.logger.warn(`   🔍 检查页面内容失败: ${e}`);
                        }
                    }
                }
                else {
                    // 记录其他API请求用于调试
                    if (url.includes('api') || url.includes('generate') || url.includes('draft')) {
                        logger_1.logger.debug(`   📡 其他API请求: ${url}`);
                    }
                }
            }
            catch (e) {
                logger_1.logger.warn(`   ⚠️ 生成响应解析异常: ${e}`);
                logger_1.logger.warn(`   ⚠️ 响应URL: ${response.url()}, 状态码: ${response.status()}`);
            }
        });
    }
    /**
     * 设置资产列表API监听器，用于获取视频URL
     */
    _setupAssetListListener(page) {
        page.on('response', async (response) => {
            try {
                const url = response.url();
                if (url.includes('/mweb/v1/get_asset_list')) {
                    logger_1.logger.info(`📥 拦截到资产列表API响应: ${url}`);
                    const json = await response.json();
                    logger_1.logger.debug(`   响应数据: ${JSON.stringify(json, null, 2).substring(0, 500)}...`);
                    // 提取防串台标签
                    const extractedTags = this._extractTagsFromAssetList(json);
                    // 回传防串台标签（只回传8位字符内容）
                    if (extractedTags.length > 0 && this._onAntiCollisionTagReceived) {
                        logger_1.logger.info(`   📤 回传 ${extractedTags.length} 个防串台标签（仅8位字符内容）`);
                        for (const tagContent of extractedTags) {
                            // 使用'asset_list'作为taskId标识来源，只回传8位字符内容
                            this._onAntiCollisionTagReceived('asset_list', tagContent);
                            logger_1.logger.info(`   🏷️ 回传标签内容: ${tagContent}`);
                        }
                    }
                    // 从响应中提取视频URL和错误信息
                    const extractResult = this._extractVideoUrlFromAssetList(json);
                    if (extractResult && (extractResult.success.length > 0 || extractResult.failed.length > 0)) {
                        logger_1.logger.info(`   🎯 提取结果 - 成功: ${extractResult.success.length} 个, 失败: ${extractResult.failed.length} 个`);
                        const pageSlot = this._findSlotByPage(page);
                        if (pageSlot) {
                            pageSlot.lastNetworkAt = Date.now();
                        }
                        // 处理成功的项目 - 资产列表回调不需要依赖task_id匹配
                        if (extractResult.success.length > 0) {
                            logger_1.logger.info(`   ✅ 成功提取 ${extractResult.success.length} 个视频URL`);
                            for (const videoItem of extractResult.success) {
                                logger_1.logger.info(`   📤 回报视频URL: ID=${videoItem.id}, URL=${videoItem.url.substring(0, 100)}...`);
                                // 直接使用asset_list中的项目ID作为external_task_id，不需要task_id匹配
                                const externalTaskId = videoItem.id;
                                logger_1.logger.info(`   🏷️ 使用asset_list中的项目ID作为外部任务ID: ${externalTaskId}`);
                                // 记录资产状态，供槽位轮询兜底使用
                                this._assetTaskStateByExternalId.set(externalTaskId, {
                                    status: 'success',
                                    videoUrl: videoItem.url,
                                    updatedAt: Date.now()
                                });
                                // 若能匹配到槽位，标记该槽位已收到可用URL
                                const matchedSlot = this._findSlotByExternalTaskId(externalTaskId);
                                if (matchedSlot) {
                                    matchedSlot._videoUrlReceived = true;
                                    matchedSlot._videoUrlProcessed = true;
                                    matchedSlot.lastNetworkAt = Date.now();
                                    logger_1.logger.info(`   🔗 external_task_id 命中槽位: ${matchedSlot.taskId} <- ${externalTaskId}`);
                                }
                                if (this._onVideoUrlReceived) {
                                    // 从原始asset_list数据中找到对应的item来提取标签
                                    const originalItem = json.data.asset_list.find((originalItem) => originalItem.id === videoItem.id);
                                    const tagContent = originalItem ? this._extractSingleTagFromItem(originalItem) : undefined;
                                    // 对于资产列表回调，taskId可以设为'asset_list'标识来源
                                    this._onVideoUrlReceived('asset_list', videoItem.url, externalTaskId, tagContent || undefined);
                                }
                                // 监听到asset_list响应并回报后，直接标记关联槽位为完成状态
                                logger_1.logger.info(`✅ [asset_list] 视频URL已处理，标记关联槽位完成`);
                                // 查找并标记关联的槽位
                                const associatedSlot = this._findSlotByExternalTaskId(externalTaskId);
                                if (associatedSlot) {
                                    associatedSlot._videoUrlReceived = true;
                                    associatedSlot._videoUrlProcessed = true;
                                    associatedSlot.lastNetworkAt = Date.now();
                                }
                            }
                        }
                        // 处理失败的项目 - 资产列表回调不需要依赖task_id匹配
                        if (extractResult.failed.length > 0) {
                            logger_1.logger.info(`   ⚠️ 发现 ${extractResult.failed.length} 个失败的项目`);
                            for (const failedItem of extractResult.failed) {
                                logger_1.logger.error(`   ❌ 项目失败 - ID: ${failedItem.id}, 错误信息: ${failedItem.error_msg}`);
                                // 记录失败状态，供槽位轮询兜底使用
                                this._assetTaskStateByExternalId.set(failedItem.id, {
                                    status: 'failed',
                                    errorMsg: failedItem.error_msg,
                                    updatedAt: Date.now()
                                });
                                // 回调错误信息，同样不需要task_id匹配
                                if (this._onVideoErrorReceived) {
                                    // 对于资产列表回调，taskId可以设为'asset_list'标识来源
                                    this._onVideoErrorReceived('asset_list', failedItem.id, failedItem.error_msg, failedItem.tag);
                                }
                                // 监听到asset_list失败响应并回报后，直接标记关联槽位为完成状态
                                logger_1.logger.info(`✅ [asset_list] 失败信息已处理，标记关联槽位完成`);
                                // 查找并标记关联的槽位
                                const failedAssociatedSlot = this._findSlotByExternalTaskId(failedItem.id);
                                if (failedAssociatedSlot) {
                                    failedAssociatedSlot._videoUrlReceived = true;
                                    failedAssociatedSlot._videoUrlProcessed = true;
                                    failedAssociatedSlot.lastNetworkAt = Date.now();
                                }
                            }
                        }
                        logger_1.logger.info('   🎯 资产列表API处理完成');
                    }
                    else {
                        logger_1.logger.warn(`   ⚠️ 无法从资产列表响应中提取视频URL`);
                    }
                }
            }
            catch (e) {
                logger_1.logger.warn(`   ⚠️ 资产列表响应解析异常: ${e}`);
            }
        });
    }
    /**
     * 设置历史记录API监听器，用于获取外部任务ID和视频URL
     * 暂时禁用此功能
     */
    _setupHistoryByIdsListener(page) {
        // 暂时不监听 get_history_by_ids 请求
        /*
        page.on('response', async (response) => {
            try {
                const url = response.url();
                if (url.includes('/mweb/v1/get_history_by_ids')) {
                    logger.info(`📥 拦截到历史记录API响应: ${url}`);
                    
                    const json = await response.json();
                    logger.debug(`   响应数据: ${JSON.stringify(json, null, 2).substring(0, 500)}...`);
                    
                    // 从响应中提取外部任务ID和视频URL
                    const results = this._extractVideoUrlFromHistoryByIds(json);
                    if (results && results.length > 0) {
                        logger.info(`   🎯 成功从历史记录API提取 ${results.length} 个视频URL`);
                        
                        // 获取当前页面的标签
                        const currentPageTag = await this._getPageTag(page);
                        
                        // 尝试通过标签匹配找到任务槽位
                        let slot: TaskSlot | null = null;
                        if (currentPageTag) {
                            slot = this._findSlotByTag(currentPageTag);
                            if (slot) {
                                logger.info(`   ✅ 标签匹配成功，任务ID: ${slot.taskId}, 外部任务ID: ${slot.externalTaskId}`);
                            } else {
                                logger.warn(`   ⚠️ 标签匹配失败: ${currentPageTag}`);
                                logger.info(`   📊 当前活动槽位数量: ${this._activeTaskSlots.size}, 标签列表: ${Array.from(this._activeTaskSlots.keys()).join(',')}`);
                            }
                        } else {
                            logger.warn(`   ⚠️ 无法获取当前页面标签`);
                        }
                        
                        // 如果标签匹配失败，尝试通过页面匹配
                        if (!slot) {
                            slot = this._findSlotByPage(page);
                            if (slot) {
                                logger.info(`   🔄 通过页面匹配找到任务槽位，任务ID: ${slot.taskId}, 外部任务ID: ${slot.externalTaskId}`);
                            } else {
                                logger.warn(`   ⚠️ 页面匹配也失败，无法找到对应任务槽位`);
                            }
                        }
                        
                        // 重新获取标签，传递slot参数用于异常处理
                        if (slot) {
                            await this._getPageTag(page, slot);
                        }
                        
                        // 无论是否找到任务槽位，都尝试回调视频URL
                        if (slot) {
                            // 找到任务槽位的情况
                            for (const result of results) {
                                logger.info(`   📤 回报视频URL: 外部ID=${result.externalId}, URL=${result.url.substring(0, 100)}...`);
                                
                                // 使用从历史记录中提取的外部ID作为external_task_id
                                const externalTaskId = result.externalId;
                                logger.info(`   🏷️ 使用历史记录中的外部ID作为外部任务ID: ${externalTaskId}`);
                                
                                if (this._onVideoUrlReceived) {
                                    this._onVideoUrlReceived(slot.taskId, result.url, externalTaskId, undefined);
                                }
                                
                                // 标记视频URL已处理
                                slot._videoUrlProcessed = true;
                            }
                        } else {
                            // 未找到任务槽位的情况，但仍尝试回调
                            logger.warn(`   ⚠️ 无法关联到具体任务，但仍尝试回调视频URL`);
                            for (const result of results) {
                                logger.info(`   📤 回报视频URL（无任务关联）: 外部ID=${result.externalId}, URL=${result.url.substring(0, 100)}...`);
                                
                                // 即使没有任务关联，也使用外部ID作为external_task_id
                                const externalTaskId = result.externalId;
                                logger.info(`   🏷️ 使用历史记录中的外部ID作为外部任务ID: ${externalTaskId}`);
                                
                                if (this._onVideoUrlReceived) {
                                    this._onVideoUrlReceived('unknown', result.url, externalTaskId, undefined);
                                }
                            }
                        }
                    } else {
                        logger.warn(`   ⚠️ 无法从历史记录API响应中提取视频URL`);
                    }
                }
            } catch (e) {
                logger.warn(`   ⚠️ 历史记录API响应解析异常: ${e}`);
            }
        });
        */
    }
    /**
     * 从历史记录响应中提取视频URL
     * @param responseJson 历史记录响应JSON数据
     * @returns 返回{externalId: string, url: string}[] 数组
     */
    _extractVideoUrlFromHistoryByIds(responseJson) {
        try {
            logger_1.logger.debug(`   开始解析历史记录响应以提取视频URL`);
            if (!responseJson || !responseJson.data) {
                logger_1.logger.warn(`   ❌ 响应数据为空或缺少data字段`);
                return null;
            }
            const data = responseJson.data;
            const result = [];
            // 使用item中的history_record_id作为外部ID
            for (const key in data) {
                if (data.hasOwnProperty(key)) {
                    const item = data[key];
                    // 使用item中的history_record_id作为外部ID
                    const externalId = item.history_record_id;
                    if (!externalId) {
                        logger_1.logger.warn(`   ❌ 无法获取到history_record_id，跳过当前项: ${key}`);
                        continue;
                    }
                    logger_1.logger.info(`   正在处理外部ID: ${externalId}`);
                    // 从item的结构中提取视频URL
                    if (item.item_list && Array.isArray(item.item_list)) {
                        for (const listItem of item.item_list) {
                            if (listItem.video && listItem.video.transcoded_video && listItem.video.transcoded_video.origin) {
                                const videoUrl = listItem.video.transcoded_video.origin.video_url;
                                if (videoUrl) {
                                    // 处理Unicode编码的URL
                                    const decodedUrl = this._decodeUnicodeUrl(videoUrl);
                                    logger_1.logger.info(`   🎯 成功提取视频URL: ${decodedUrl.substring(0, 100)}...`);
                                    result.push({ externalId: externalId, url: decodedUrl });
                                }
                            }
                        }
                    }
                }
            }
            if (result.length > 0) {
                logger_1.logger.info(`   ✅ 成功提取 ${result.length} 个视频URL`);
                return result;
            }
            logger_1.logger.warn(`   ⚠️ 未找到有效的视频URL`);
            return null;
        }
        catch (e) {
            logger_1.logger.warn(`   ⚠️ 解析历史记录响应异常: ${e}`);
            return null;
        }
    }
    /**
     * 获取页面中的防串台标签
     * @param page 页面对象
     * @param slot 可选的任务槽位，用于在异常时移除tag映射
     */
    async _getPageTag(page, slot) {
        try {
            const result = await page.evaluate(() => {
                const TAG_MARKER = '⟨⟩⟨';
                const allText = document.body.textContent || '';
                const tagMatches = allText.match(/⟨⟩⟨([a-zA-Z0-9]{8})⟩/);
                // 调试：返回更多信息
                return {
                    tag: tagMatches ? tagMatches[1] : null,
                    allTextLength: allText.length,
                    hasMarker: allText.includes(TAG_MARKER),
                    possibleMatches: allText.match(/⟨⟩⟨[a-zA-Z0-9]{8}⟩/g) || []
                };
            });
            logger_1.logger.debug(`   页面标签检查: 长度=${result.allTextLength}, 包含标记=${result.hasMarker}, 匹配数=${result.possibleMatches.length}, 匹配结果=${JSON.stringify(result.possibleMatches)}`);
            if (result.tag) {
                logger_1.logger.info(`   🏷️ 成功获取页面标签: ${result.tag}`);
                return result.tag;
            }
            else {
                logger_1.logger.warn(`   ⚠️ 页面中未找到防串台标签`);
                logger_1.logger.debug(`   可能的标签: ${JSON.stringify(result.possibleMatches)}`);
                return null;
            }
        }
        catch (e) {
            logger_1.logger.warn(`   获取页面标签异常: ${e}`);
            // 如果页面已关闭，移除对应的tag映射避免后续错误
            const error = e;
            if (error.message && error.message.includes('Target page, context or browser has been closed')) {
                logger_1.logger.warn(`   🗑️ 页面已关闭，清理相关映射`);
                if (slot && slot.tag) {
                    this._activeTaskSlots.delete(slot.tag);
                    logger_1.logger.debug(`   🏷️ 已移除关闭页面的tag映射: ${slot.tag}`);
                }
            }
            else if (slot && slot.tag) {
                // 其他异常时也移除映射
                logger_1.logger.warn(`   ⚠️ tag检测异常，移除映射: ${slot.tag} -> ${slot.taskId}`);
                this._activeTaskSlots.delete(slot.tag);
                logger_1.logger.debug(`   🏷️ 已从标签映射中移除异常tag: ${slot.tag}`);
            }
            return null;
        }
    }
    /**
     * 资产列表提取结果接口
     */
    /**
     * 从asset_list响应中提取防串台标签
     * @param responseJson 资产列表响应JSON数据
     * @returns 返回提取到的标签数组
     */
    _extractTagsFromAssetList(responseJson) {
        try {
            const tags = new Set();
            const TAG_PATTERN = /⟨⟩⟨([a-f0-9]{8})⟩/g;
            if (!responseJson || !responseJson.data) {
                logger_1.logger.warn(`   ❌ 响应数据为空或缺少data字段`);
                return [];
            }
            const data = responseJson.data;
            if (!data.asset_list || !Array.isArray(data.asset_list)) {
                logger_1.logger.warn(`   ❌ 响应数据缺少asset_list字段或不是数组`);
                return [];
            }
            // 遍历所有项目
            for (const item of data.asset_list) {
                if (!item.video)
                    continue;
                // 从 history_group_key 中提取标签
                const historyTags = this._extractTagsFromText(item.video.history_group_key || '', TAG_PATTERN);
                historyTags.forEach(tag => tags.add(tag));
                // 从 draft_content 中提取标签
                const draftTags = this._extractTagsFromDraftContent(item.video.draft_content || '', TAG_PATTERN);
                draftTags.forEach(tag => tags.add(tag));
                // 记录找到的标签
                const allFoundTags = [...historyTags, ...draftTags];
                if (allFoundTags.length > 0) {
                    logger_1.logger.info(`   🏷️ 项目 ${item.id} 找到标签: ${allFoundTags.join(', ')}`);
                }
            }
            const uniqueTags = Array.from(tags);
            if (uniqueTags.length > 0) {
                logger_1.logger.info(`✅ 总共提取到 ${uniqueTags.length} 个唯一标签: ${uniqueTags.join(', ')}`);
            }
            return uniqueTags;
        }
        catch (e) {
            logger_1.logger.warn(`   ⚠️ 提取标签异常: ${e}`);
            return [];
        }
    }
    /**
     * 从文本中提取防串台标签
     * @param text 要搜索的文本
     * @param pattern 标签正则表达式
     * @returns 提取到的标签数组
     */
    _extractTagsFromText(text, pattern) {
        if (!text)
            return [];
        const tags = [];
        let match;
        // 重置正则表达式状态
        pattern.lastIndex = 0;
        while ((match = pattern.exec(text)) !== null) {
            tags.push(match[1]); // 只返回标签内容，不包含⟨⟩⟨⟩
        }
        return tags;
    }
    /**
     * 从draft_content JSON字符串中提取防串台标签
     * @param draftContent draft_content字段内容
     * @param pattern 标签正则表达式
     * @returns 提取到的标签数组
     */
    _extractTagsFromDraftContent(draftContent, pattern) {
        if (!draftContent)
            return [];
        try {
            // 尝试解析JSON
            const draftObj = JSON.parse(draftContent);
            const tags = [];
            // 递归搜索所有字符串字段
            this._searchTagsInObject(draftObj, tags, pattern);
            return tags;
        }
        catch (e) {
            // 如果不是有效的JSON，直接作为文本搜索
            logger_1.logger.warn(`   ⚠️ draft_content不是有效JSON，作为文本搜索: ${e}`);
            return this._extractTagsFromText(draftContent, pattern);
        }
    }
    /**
     * 递归搜索对象中的所有字符串字段，提取标签
     * @param obj 要搜索的对象
     * @param tags 标签数组（累积）
     * @param pattern 标签正则表达式
     */
    _searchTagsInObject(obj, tags, pattern) {
        if (typeof obj === 'string') {
            // 如果是字符串，直接提取标签
            const foundTags = this._extractTagsFromText(obj, pattern);
            foundTags.forEach(tag => tags.push(tag));
        }
        else if (Array.isArray(obj)) {
            // 如果是数组，递归处理每个元素
            obj.forEach(item => this._searchTagsInObject(item, tags, pattern));
        }
        else if (obj && typeof obj === 'object') {
            // 如果是对象，递归处理每个属性
            Object.values(obj).forEach(value => this._searchTagsInObject(value, tags, pattern));
        }
    }
    /**
     * 从单个项目项中提取防串台标签
     * @param item 项目项
     * @returns 标签内容或null
     */
    _extractSingleTagFromItem(item) {
        try {
            const TAG_PATTERN = /⟨⟩⟨([a-f0-9]{8})⟩/g;
            if (!item.video)
                return null;
            // 从 history_group_key 中提取标签
            const historyTags = this._extractTagsFromText(item.video.history_group_key || '', TAG_PATTERN);
            if (historyTags.length > 0) {
                return historyTags[0]; // 返回第一个找到的标签
            }
            // 从 draft_content 中提取标签
            const draftTags = this._extractTagsFromDraftContent(item.video.draft_content || '', TAG_PATTERN);
            if (draftTags.length > 0) {
                return draftTags[0]; // 返回第一个找到的标签
            }
            return null;
        }
        catch (e) {
            logger_1.logger.warn(`   ⚠️ 提取单个项目标签异常: ${e}`);
            return null;
        }
    }
    /**
     * 格式化防串台标签
     * @param tagContent 标签内容（8位字符）
     * @returns 完整标签格式
     */
    _formatTag(tagContent) {
        return `⟨⟩⟨${tagContent}⟩`;
    }
    _extractVideoUrlFromAssetList(responseJson) {
        try {
            logger_1.logger.debug(`   开始解析资产列表响应以提取视频URL和错误信息`);
            if (!responseJson || !responseJson.data) {
                logger_1.logger.warn(`   ❌ 响应数据为空或缺少data字段`);
                return null;
            }
            const data = responseJson.data;
            logger_1.logger.info(`🔍 开始处理 asset_list 响应，项目数量: ${data.asset_list?.length || 0}`);
            // 检查是否有asset_list字段
            if (!data.asset_list || !Array.isArray(data.asset_list)) {
                logger_1.logger.warn(`   ❌ 响应数据缺少asset_list字段或不是数组`);
                return null;
            }
            const result = {
                success: [],
                failed: []
            };
            // 遍历所有项目
            for (const item of data.asset_list) {
                logger_1.logger.info("==============");
                logger_1.logger.info(`   处理项目 ID: ${item.id}, 视频状态: ${item.video?.status || '未知'}`);
                if (!item.video) {
                    logger_1.logger.warn(`   ⚠️ 项目 ${item.id} 缺少video信息，跳过`);
                    continue;
                }
                const videoStatus = item.video.status;
                if (videoStatus === 50) {
                    // 成功完成状态的项目
                    logger_1.logger.info(`   ✅ 找到状态为50的完成项目，ID: ${item.id}`);
                    // 检查item_list中的第一个项目状态是否为144（审核通过）
                    if (item.video.item_list && Array.isArray(item.video.item_list) && item.video.item_list.length > 0) {
                        const firstItem = item.video.item_list[0];
                        // 提取item_list[0].video.transcoded_video.origin.video_url
                        if (firstItem.video && firstItem.video.transcoded_video && firstItem.video.transcoded_video.origin) {
                            const videoUrl = firstItem.video.transcoded_video.origin.video_url;
                            if (videoUrl) {
                                // 处理Unicode编码的URL
                                const decodedUrl = this._decodeUnicodeUrl(videoUrl);
                                logger_1.logger.info(`   🎯 成功提取视频URL: ${decodedUrl.substring(0, 100)}...`);
                                result.success.push({ id: item.id, url: decodedUrl });
                            }
                        }
                    }
                }
                else if (videoStatus === 20) {
                    // 正在执行状态，不发送失败回报，只记录状态
                    logger_1.logger.info(`   ⏳ 项目正在执行中，状态: ${videoStatus}，ID: ${item.id}`);
                    logger_1.logger.info(`🎯 发现状态20任务: ${item.id}`);
                    logger_1.logger.info(`🔍 _onVideoStatusReceived 是否存在: ${!!this._onVideoStatusReceived}`);
                    // 记录运行中状态，供槽位轮询兜底使用
                    this._assetTaskStateByExternalId.set(item.id, {
                        status: 'running',
                        updatedAt: Date.now()
                    });
                    // 提取防串台标签（如果存在）
                    const tagContent = this._extractSingleTagFromItem(item);
                    if (tagContent) {
                        logger_1.logger.info(`   🏷️ 运行中任务包含标签: ${tagContent}`);
                        // 回传运行中状态和标签信息
                        if (this._onVideoStatusReceived) {
                            logger_1.logger.info(`📞 准备调用状态回调: asset_list, ${item.id}, running, 标签: ${tagContent}`);
                            this._onVideoStatusReceived('asset_list', item.id, 'running', `任务正在执行中，状态: ${videoStatus}`, tagContent);
                            logger_1.logger.info(`✅ 状态回调已发送`);
                        }
                        else {
                            logger_1.logger.warn(`⚠️ _onVideoStatusReceived 回调未设置`);
                        }
                    }
                    else {
                        logger_1.logger.info(`   📝 运行中任务无标签信息`);
                    }
                    continue;
                }
                else if (videoStatus === 30 || videoStatus === 40) {
                    // 失败状态的项目
                    logger_1.logger.info(`   ❌ 找到失败状态项目，ID: ${item.id}, 状态: ${videoStatus}`);
                    let errorMsg = `视频生成失败，状态码: ${videoStatus}`;
                    // 尝试提取 fail_starling_message
                    if (item.video.fail_starling_message) {
                        errorMsg = item.video.fail_starling_message;
                        logger_1.logger.info(`   📝 提取到错误信息: ${errorMsg}`);
                    }
                    else if (item.video.fail_starling_key) {
                        errorMsg = `错误代码: ${item.video.fail_starling_key}`;
                        logger_1.logger.info(`   📝 提取到错误代码: ${item.video.fail_starling_key}`);
                    }
                    // 提取防串台标签（如果存在）
                    const tagContent = this._extractSingleTagFromItem(item);
                    if (tagContent) {
                        logger_1.logger.info(`   🏷️ 失败任务包含标签: ${tagContent}`);
                        // 在失败回报中包含标签信息
                        result.failed.push({ id: item.id, error_msg: errorMsg, tag: tagContent });
                    }
                    else {
                        result.failed.push({ id: item.id, error_msg: errorMsg });
                    }
                }
                else {
                    // 其他未知状态
                    logger_1.logger.warn(`   ⚠️ 项目 ${item.id} 处于未知状态: ${videoStatus}，跳过`);
                    continue;
                }
            }
            logger_1.logger.info(`   ✅ 处理完成 - 成功: ${result.success.length} 个, 失败: ${result.failed.length} 个`);
            // 如果有成功或失败的项目，返回结果
            if (result.success.length > 0 || result.failed.length > 0) {
                return result;
            }
            logger_1.logger.warn(`   ⚠️ 未找到有效的项目`);
            return null;
        }
        catch (e) {
            logger_1.logger.warn(`   ⚠️ 解析资产列表响应异常: ${e}`);
            return null;
        }
    }
    /**
     * 处理Unicode编码的URL
     * @param url 包含Unicode编码的URL
     */
    _decodeUnicodeUrl(url) {
        try {
            // 替换 \u0026 为 & 等常见的Unicode编码
            let decodedUrl = url.replace(/\\u0026/g, '&');
            decodedUrl = decodedUrl.replace(/\\u003d/g, '=');
            decodedUrl = decodedUrl.replace(/\\u003f/g, '?');
            // 处理其他可能的编码
            decodedUrl = decodedUrl.replace(/\\u([0-9a-fA-F]{4})/g, (match, hex) => {
                return String.fromCharCode(parseInt(hex, 16));
            });
            logger_1.logger.debug(`   🔄 URL解码完成: ${decodedUrl.substring(0, 100)}...`);
            return decodedUrl;
        }
        catch (e) {
            logger_1.logger.warn(`   ⚠️ URL解码异常: ${e}, 返回原始URL`);
            return url;
        }
    }
    /**
     * 从生成响应中提取任务ID
     * @param responseJson 响应JSON数据
     * @param tag 当前任务的防串台标签（用于精确匹配）
     */
    _extractTaskIdFromResponse(responseJson, tag) {
        try {
            logger_1.logger.debug(`   解析响应数据以提取任务ID (标签: ${tag || '无'})`);
            logger_1.logger.debug(`   响应数据类型: ${typeof responseJson}, 是否为空: ${!responseJson}`);
            if (!responseJson) {
                logger_1.logger.warn(`   ❌ 响应数据为空，无法提取任务ID`);
                return {
                    externalTaskId: null,
                    createdTime: null,
                    forecastGenerateCost: null,
                    forecastQueueCost: null
                };
            }
            // 检查响应的整体结构
            logger_1.logger.debug(`   响应顶级键: ${JSON.stringify(Object.keys(responseJson || {}))}`);
            // 根据实际API响应结构调整提取逻辑
            // 基于用户提供的真实响应结构
            // 方式1: 从 data.aigc_data.task.task_id 提取（主要方式）
            if (responseJson?.data?.aigc_data?.task?.task_id) {
                const taskId = responseJson.data.aigc_data.task.task_id;
                logger_1.logger.info(`   ✅ 从 data.aigc_data.task.task_id 提取: ${taskId}`);
                // 提取额外信息
                const createdTime = responseJson?.data?.aigc_data?.created_time || null;
                const forecastGenerateCost = responseJson?.data?.aigc_data?.forecast_generate_cost || null;
                const forecastQueueCost = responseJson?.data?.aigc_data?.forecast_queue_cost || null;
                logger_1.logger.info(`   📅 创建时间: ${createdTime}`);
                logger_1.logger.info(`   ⏱️ 预计生成时长: ${forecastGenerateCost}`);
                logger_1.logger.info(`   ⏳ 预计等待时长: ${forecastQueueCost}`);
                return {
                    externalTaskId: taskId,
                    createdTime,
                    forecastGenerateCost,
                    forecastQueueCost
                };
            }
            // 方式2: 从 data.aigc_data.task.submit_id 提取（备选方式）
            if (responseJson?.data?.aigc_data?.task?.submit_id) {
                const submitId = responseJson.data.aigc_data.task.submit_id;
                logger_1.logger.info(`   ✅ 从 data.aigc_data.task.submit_id 提取: ${submitId}`);
                // 提取额外信息
                const createdTime = responseJson?.data?.aigc_data?.created_time || null;
                const forecastGenerateCost = responseJson?.data?.aigc_data?.forecast_generate_cost || null;
                const forecastQueueCost = responseJson?.data?.aigc_data?.forecast_queue_cost || null;
                logger_1.logger.info(`   📅 创建时间: ${createdTime}`);
                logger_1.logger.info(`   ⏱️ 预计生成时长: ${forecastGenerateCost}`);
                logger_1.logger.info(`   ⏳ 预计等待时长: ${forecastQueueCost}`);
                return {
                    externalTaskId: submitId,
                    createdTime,
                    forecastGenerateCost,
                    forecastQueueCost
                };
            }
            // 方式3: 从 data.aigc_data.history_record_id 提取
            if (responseJson?.data?.aigc_data?.history_record_id) {
                const historyId = responseJson.data.aigc_data.history_record_id;
                logger_1.logger.info(`   ✅ 从 data.aigc_data.history_record_id 提取: ${historyId}`);
                // 提取额外信息
                const createdTime = responseJson?.data?.aigc_data?.created_time || null;
                const forecastGenerateCost = responseJson?.data?.aigc_data?.forecast_generate_cost || null;
                const forecastQueueCost = responseJson?.data?.aigc_data?.forecast_queue_cost || null;
                return {
                    externalTaskId: historyId,
                    createdTime,
                    forecastGenerateCost,
                    forecastQueueCost
                };
            }
            // 方式4: 从 data.aigc_data.submit_id 提取
            if (responseJson?.data?.aigc_data?.submit_id) {
                const submitId = responseJson.data.aigc_data.submit_id;
                logger_1.logger.info(`   ✅ 从 data.aigc_data.submit_id 提取: ${submitId}`);
                // 提取额外信息
                const createdTime = responseJson?.data?.aigc_data?.created_time || null;
                const forecastGenerateCost = responseJson?.data?.aigc_data?.forecast_generate_cost || null;
                const forecastQueueCost = responseJson?.data?.aigc_data?.forecast_queue_cost || null;
                return {
                    externalTaskId: submitId,
                    createdTime,
                    forecastGenerateCost,
                    forecastQueueCost
                };
            }
            // 方式5: 从 data.aigc_data.capflow_id 提取
            if (responseJson?.data?.aigc_data?.capflow_id) {
                const capflowId = responseJson.data.aigc_data.capflow_id;
                logger_1.logger.info(`   ✅ 从 data.aigc_data.capflow_id 提取: ${capflowId}`);
                // 提取额外信息
                const createdTime = responseJson?.data?.aigc_data?.created_time || null;
                const forecastGenerateCost = responseJson?.data?.aigc_data?.forecast_generate_cost || null;
                const forecastQueueCost = responseJson?.data?.aigc_data?.forecast_queue_cost || null;
                return {
                    externalTaskId: capflowId,
                    createdTime,
                    forecastGenerateCost,
                    forecastQueueCost
                };
            }
            // 方式6: 从 data.aigc_data.generate_id 提取
            if (responseJson?.data?.aigc_data?.generate_id) {
                const generateId = responseJson.data.aigc_data.generate_id;
                logger_1.logger.info(`   ✅ 从 data.aigc_data.generate_id 提取: ${generateId}`);
                // 提取额外信息
                const createdTime = responseJson?.data?.aigc_data?.created_time || null;
                const forecastGenerateCost = responseJson?.data?.aigc_data?.forecast_generate_cost || null;
                const forecastQueueCost = responseJson?.data?.aigc_data?.forecast_queue_cost || null;
                return {
                    externalTaskId: generateId,
                    createdTime,
                    forecastGenerateCost,
                    forecastQueueCost
                };
            }
            // 保留原有的兼容性提取方式
            if (responseJson?.data?.task_id) {
                const taskId = responseJson.data.task_id;
                logger_1.logger.info(`   ✅ 从 data.task_id 提取: ${taskId}`);
                return {
                    externalTaskId: taskId,
                    createdTime: null,
                    forecastGenerateCost: null,
                    forecastQueueCost: null
                };
            }
            if (responseJson?.task_id) {
                const taskId = responseJson.task_id;
                logger_1.logger.info(`   ✅ 从 task_id 提取: ${taskId}`);
                return {
                    externalTaskId: taskId,
                    createdTime: null,
                    forecastGenerateCost: null,
                    forecastQueueCost: null
                };
            }
            if (responseJson?.data?.id) {
                const id = responseJson.data.id;
                logger_1.logger.info(`   ✅ 从 data.id 提取: ${id}`);
                return {
                    externalTaskId: id,
                    createdTime: null,
                    forecastGenerateCost: null,
                    forecastQueueCost: null
                };
            }
            if (responseJson?.result?.task_id) {
                const taskId = responseJson.result.task_id;
                logger_1.logger.info(`   ✅ 从 result.task_id 提取: ${taskId}`);
                return {
                    externalTaskId: taskId,
                    createdTime: null,
                    forecastGenerateCost: null,
                    forecastQueueCost: null
                };
            }
            logger_1.logger.warn(`   ❌ 未找到有效的任务ID字段`);
            logger_1.logger.debug(`   完整响应: ${JSON.stringify(responseJson, null, 2)}`);
            return {
                externalTaskId: null,
                createdTime: null,
                forecastGenerateCost: null,
                forecastQueueCost: null
            };
        }
        catch (e) {
            logger_1.logger.warn(`   ❌ 提取任务ID异常: ${e.message || e}`);
            logger_1.logger.warn(`   ❌ 异常堆栈: ${e.stack || 'no stack'}`);
            return {
                externalTaskId: null,
                createdTime: null,
                forecastGenerateCost: null,
                forecastQueueCost: null
            };
        }
    }
    /**
     * 根据页面找到对应的任务槽位
     */
    _findSlotByPage(page) {
        for (const slot of this._activeTaskSlots.values()) {
            if (slot.page === page) {
                return slot;
            }
        }
        return null;
    }
    /**
     * 根据标签找到对应的任务槽位
     */
    _findSlotByTag(tag) {
        for (const slot of this._activeTaskSlots.values()) {
            if (slot.tag === tag) {
                return slot;
            }
        }
        return null;
    }
    /**
     * 根据 external_task_id 找到对应槽位
     */
    _findSlotByExternalTaskId(externalTaskId) {
        if (!externalTaskId) {
            return null;
        }
        for (const slot of this._activeTaskSlots.values()) {
            if (slot.externalTaskId && slot.externalTaskId === externalTaskId) {
                return slot;
            }
        }
        return null;
    }
    /**
     * 获取 external_task_id 对应的最新资产状态（用于兜底判定）
     */
    _getAssetTaskState(externalTaskId) {
        if (!externalTaskId) {
            return null;
        }
        return this._assetTaskStateByExternalId.get(externalTaskId) || null;
    }
    /**
     * 启动浏览器 (persistent context 保持登录态)
     */
    async start() {
        logger_1.logger.info('🚀 启动浏览器引擎...');
        this.context = await playwright_1.chromium.launchPersistentContext(this.userDataDir, {
            headless: config.HEADLESS,
            channel: 'chrome',
            args: [
                '--disable-infobars',
                '--start-maximized',
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-dev-shm-usage',
                '--mute-audio',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-breakpad',
                '--disable-component-extensions-with-background-pages',
                '--disable-ipc-flooding-protection',
                '--disable-renderer-backgrounding',
                '--enable-features=NetworkService,NetworkServiceInProcess',
            ],
            ignoreDefaultArgs: ['--enable-automation'],
            viewport: config.HEADLESS ? { width: 1920, height: 1080 } : null,
            locale: 'zh-CN',
            timezoneId: 'Asia/Shanghai',
            acceptDownloads: true,
        });
        this.page = this.context.pages()[0] || await this.context.newPage();
        this._mainPage = this.page;
        // 在页面加载前设置监听器，确保捕获所有请求
        this._setupCreditListener(this.page);
        this._setupWorkspaceListener(this.page);
        this._setupGenerateListener(this.page);
        this._setupAssetListListener(this.page);
        await this._injectOptimizer(this.page);
        // 监听新页面创建，自动设置积分拦截和生成监听
        this.context.on('page', (newPage) => {
            this._setupCreditListener(newPage);
            this._setupWorkspaceListener(newPage);
            this._setupGenerateListener(newPage);
            this._setupAssetListListener(newPage);
        });
        // 注入反检测脚本
        await this.context.addInitScript(`
            // 隐藏 webdriver 标记
            try {
                Object.defineProperty(Navigator.prototype, 'webdriver', {
                    configurable: true, get: () => undefined
                });
                delete Navigator.prototype.webdriver;
            } catch(e) {}
            try {
                if (Object.getOwnPropertyDescriptor(navigator, 'webdriver')) {
                    Object.defineProperty(navigator, 'webdriver', {
                        configurable: true, value: undefined, writable: true
                    });
                    delete navigator.webdriver;
                }
            } catch(e) {}
            if ('webdriver' in navigator) {
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => undefined, configurable: false
                });
            }
            delete window.__playwright;
            delete window.__pw_manual;
            Object.defineProperty(navigator, 'languages', {
                get: () => ['zh-CN', 'zh', 'en']
            });
            if (!window.chrome) {
                window.chrome = {};
            }
            if (!window.chrome.runtime) {
                window.chrome.runtime = {
                    connect: function() {},
                    sendMessage: function() {},
                    id: undefined,
                };
            }
            if (navigator.connection) {
                Object.defineProperty(navigator.connection, 'rtt', { get: () => 50 });
            }
            window.__lastMousePos = {x: 0, y: 0};
            document.addEventListener('mousemove', (e) => {
                window.__lastMousePos = {x: e.clientX, y: e.clientY};
            }, true);
        `);
        // 清理多余的 about:blank 页面
        for (const p of this.context.pages()) {
            if (p !== this.page) {
                const url = p.url();
                if (url === 'about:blank' || url.includes('chrome://newtab') || url.includes('chrome://new-tab-page')) {
                    try {
                        await p.close();
                    }
                    catch { }
                }
            }
        }
        logger_1.logger.info('✅ 浏览器已启动');
    }
    /**
     * 标记任务页面完成并准备关闭
     */
    async _markTaskCompleted(page) {
        if (!page)
            return;
        try {
            this._completedTaskPages.add(page);
            logger_1.logger.debug(`   📝 标记页面为已完成: ${page.url()}`);
            // 立即尝试关闭已完成的任务页面
            await this._closeCompletedTaskPages();
        }
        catch (e) {
            logger_1.logger.debug(`   ⚠️ 标记任务完成失败: ${e}`);
        }
    }
    /**
     * 关闭所有已完成的任务页面
     */
    async _closeCompletedTaskPages() {
        if (!this.context)
            return;
        try {
            const pagesToClose = Array.from(this._completedTaskPages);
            let closedCount = 0;
            for (const page of pagesToClose) {
                try {
                    // 检查页面是否仍然存在且不是主页面
                    if (page !== this.page && !page.isClosed()) {
                        const url = page.url();
                        await page.close();
                        this._completedTaskPages.delete(page);
                        closedCount++;
                        logger_1.logger.info(`   🗑️ 已关闭完成的任务页面: ${url}`);
                    }
                    else {
                        // 如果页面已关闭或是主页面，从集合中移除
                        this._completedTaskPages.delete(page);
                    }
                }
                catch (e) {
                    logger_1.logger.debug(`   ⚠️ 关闭已完成页面失败: ${e}`);
                    this._completedTaskPages.delete(page);
                }
            }
            if (closedCount > 0) {
                logger_1.logger.info(`   🧹 清理完成，关闭了 ${closedCount} 个已完成的任务页面`);
            }
        }
        catch (e) {
            logger_1.logger.debug(`   ⚠️ 关闭已完成任务页面时出错: ${e}`);
        }
    }
    /**
     * 清理多余的标签页
     */
    async _cleanupUnusedTabs() {
        if (!this.context || !this.page)
            return;
        try {
            // 首先关闭已完成的任务页面
            await this._closeCompletedTaskPages();
            const allPages = this.context.pages();
            const mainPageUrl = this.page.url();
            let closedCount = 0;
            logger_1.logger.debug(`   📊 开始清理标签页，总数: ${allPages.length}，主页面URL: ${mainPageUrl}`);
            for (const p of allPages) {
                if (p !== this.page) {
                    const url = p.url();
                    // 只关闭明确的空白页和新标签页，避免误关有用页面
                    if (url === 'about:blank' ||
                        url.includes('chrome://newtab') ||
                        url.includes('chrome://new-tab-page')) {
                        try {
                            await p.close();
                            closedCount++;
                            logger_1.logger.debug(`   🗑️ 已关闭空白标签页: ${url}`);
                        }
                        catch (e) {
                            logger_1.logger.debug(`   ⚠️ 关闭标签页失败: ${e}`);
                        }
                    }
                    else {
                        logger_1.logger.debug(`   📝 保留标签页: ${url}`);
                    }
                }
            }
            if (closedCount > 0) {
                logger_1.logger.info(`   🧹 清理完成，关闭了 ${closedCount} 个空白标签页`);
            }
            const remainingTabs = allPages.length - closedCount;
            logger_1.logger.debug(`   📊 清理后标签页数量: ${remainingTabs}`);
        }
        catch (e) {
            logger_1.logger.debug(`   ⚠️ 清理标签页时出错: ${e}`);
        }
    }
    /**
     * 关闭浏览器
     */
    async stop() {
        if (this.context) {
            await this.context.close();
        }
        logger_1.logger.info('🛑 浏览器已关闭');
    }
    /**
     * 检查登录状态
     */
    async login() {
        logger_1.logger.info('🔐 正在检查登录状态...');
        const generateUrl = 'https://jimeng.jianying.com/ai-tool/generate?type=video';
        await this.page.goto(generateUrl, { waitUntil: 'domcontentloaded' });
        await sleep(5000);
        await this._handleAgreementPopup();
        await sleep(1000);
        // 清理可能存在的多余标签页
        await this._cleanupUnusedTabs();
        const maxRetries = 5;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            const currentUrl = this.page.url();
            logger_1.logger.info(`   当前URL: ${currentUrl}`);
            if (currentUrl.includes('generate')) {
                logger_1.logger.info('✅ 已登录，当前在生成页面');
                break;
            }
            logger_1.logger.warn(`⚠️ 未登录 (第${attempt + 1}次检测)，页面被重定向到: ${currentUrl}`);
            logger_1.logger.warn('='.repeat(50));
            logger_1.logger.warn('请在 Chrome 浏览器中完成以下操作：');
            logger_1.logger.warn('  1. 如果有\'同意协议\'弹窗，点击\'同意\'');
            logger_1.logger.warn('  2. 点击页面上的登录按钮');
            logger_1.logger.warn('  3. 用抖音扫码登录');
            logger_1.logger.warn('  4. 登录成功后，等待30秒自动继续');
            logger_1.logger.warn('='.repeat(50));
            await sleep(30000);
            await sleep(2000);
            await this.page.goto(generateUrl, { waitUntil: 'domcontentloaded' });
            await sleep(5000);
            await this._handleAgreementPopup();
            await sleep(1000);
        }
        if (!this.page.url().includes('generate')) {
            logger_1.logger.error('❌ 登录失败，无法进入生成页面');
            throw new Error('登录失败');
        }
        await this._closePopups();
        logger_1.logger.info('✅ 登录状态正常，已进入生成页面');
    }
    /**
     * 关闭弹窗
     */
    async _closePopups() {
        try {
            await this.page.keyboard.press('Escape');
            await this._humanWait(0.5, 1);
            const closeSelectors = [
                '[class*="close-icon"]',
                '[class*="modal-close"]',
                '[class*="dialog"] [class*="close"]',
                'button[aria-label="Close"]',
                'button[aria-label="关闭"]',
            ];
            for (const sel of closeSelectors) {
                try {
                    const btn = this.page.locator(sel).first();
                    if (await btn.isVisible({ timeout: 500 })) {
                        await btn.click();
                        await this._humanWait(0.3, 0.8);
                        logger_1.logger.info('   ✅ 已关闭弹窗');
                        return;
                    }
                }
                catch { }
            }
            await this.page.keyboard.press('Escape');
            await this._humanWait(0.3, 0.5);
        }
        catch (e) {
            logger_1.logger.debug(`关闭弹窗: ${e}`);
        }
    }
    /**
     * 处理协议弹窗
     */
    async _handleAgreementPopup() {
        try {
            const popupText = this.page.locator('text=同意协议后前往登录').first();
            if (!await popupText.isVisible({ timeout: 3000 })) {
                return false;
            }
            logger_1.logger.info('   检测到协议弹窗');
            const agreeSelectors = [
                'button:text-is("同意")',
                'button:has-text("同意"):not(:has-text("不"))',
            ];
            for (const sel of agreeSelectors) {
                try {
                    const btn = this.page.locator(sel).first();
                    if (await btn.isVisible({ timeout: 2000 })) {
                        await btn.click();
                        logger_1.logger.info('   ✅ 已自动点击\'同意\'协议');
                        await this._humanWait(2, 3);
                        return true;
                    }
                }
                catch { }
            }
            // 备用: JS 点击
            try {
                await this.page.evaluate(`
                    const buttons = document.querySelectorAll('button');
                    for (const btn of buttons) {
                        if (btn.textContent.trim() === '同意') {
                            btn.click();
                            break;
                        }
                    }
                `);
                logger_1.logger.info('   ✅ 已通过JS点击\'同意\'协议');
                await this._humanWait(2, 3);
                return true;
            }
            catch { }
            return false;
        }
        catch (e) {
            logger_1.logger.debug(`协议弹窗处理: ${e}`);
            return false;
        }
    }
    /**
     * 生成视频
     */
    async generateVideo(prompt, duration = 10, ratio = '16:9', refImageUrl, model = 'seedance2.0') {
        try {
            logger_1.logger.info(`🎬 开始生成视频: ${prompt.substring(0, 50)}...`);
            await this._navigateToGeneratePage();
            await this._humanPause();
            await this._selectVideoMode();
            await this._humanPause();
            const lower = (model || '').toLowerCase();
            const isFast = lower.includes('fast');
            const isVip = lower.includes('vip');
            let targetModel = isFast ? 'Seedance 2.0 Fast' : 'Seedance 2.0';
            if (isVip) targetModel += ' VIP';
            logger_1.logger.info(`🎯 目标模型: ${targetModel}`);
            await this._selectModel(targetModel);
            if (!await this._verifyModel(targetModel)) {
                logger_1.logger.warn('⚠️ 模型验证无法确认 (可能是布局检测问题)，继续尝试生成');
            }
            await this._humanPause();
            await this._selectDuration(duration);
            await this._humanPause();
            await this._selectRatio(ratio);
            await this._humanPause();
            if (refImageUrl) {
                await this._clearReferenceResources('首尾帧');
                await this._uploadReferenceImage(refImageUrl);
                await this._humanPause();
            }
            await this._typePrompt(prompt);
            const oldVideoUrls = await this._collectAllVideoUrls();
            logger_1.logger.info(`   🔒 防串台基准: 已记录 ${oldVideoUrls.size} 个已知视频URL`);
            await this._clickGenerate();
            if (!await this._waitForGeneration()) {
                logger_1.logger.error('❌ 生成超时或失败');
                return null;
            }
            const videoUrl = await this._getVideoUrl(oldVideoUrls);
            return videoUrl;
        }
        catch (e) {
            if (e.name === 'TimeoutError') {
                logger_1.logger.error('❌ 操作超时');
            }
            else {
                logger_1.logger.error(`❌ 生成过程异常: ${e}`);
            }
            return null;
        }
    }
    /**
     * 导航到生成页面
     */
    async _navigateToGeneratePage() {
        const targetUrl = 'https://jimeng.jianying.com/ai-tool/generate?type=video';
        const currentUrl = this.page.url();
        if (!currentUrl.includes('generate') || !currentUrl.includes('type=video')) {
            logger_1.logger.info('📍 导航到即梦视频生成页面...');
            await this.page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
            await this._humanWait(3, 5);
            await this._closePopups();
        }
    }
    /**
     * 选择视频生成模式
     */
    async _selectVideoMode() {
        logger_1.logger.info('📹 选择视频生成模式...');
        try {
            // 检测底部栏是否处于 Agent 模式
            const modeInfo = await this.page.evaluate(() => {
                // 查找底部栏中的模式按钮（包含 "Agent" 或 "视频生成" 文字的按钮）
                const allEls = document.querySelectorAll('*');
                const vh = window.innerHeight;
                for (const el of allEls) {
                    const rect = el.getBoundingClientRect();
                    // 底部栏区域
                    if (rect.top > vh * 0.85 && rect.height > 20 && rect.height < 60
                        && rect.width > 60 && rect.width < 300) {
                        const text = el.textContent?.trim() || '';
                        if (text.includes('Agent') && text.includes('模式') && text.length < 20) {
                            return { mode: 'agent', cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2, text };
                        }
                    }
                }
                // 也检查 "创作类型" 相关的选择器
                const modeButtons = document.querySelectorAll('[class*="creation-type"], [class*="mode-select"], [class*="creation_type"]');
                for (const el of modeButtons) {
                    const text = el.textContent?.trim() || '';
                    if (text.includes('Agent')) {
                        const rect = el.getBoundingClientRect();
                        return { mode: 'agent', cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2, text };
                    }
                }
                return { mode: 'video' }; // 未检测到 Agent 模式，假定已在视频模式
            });
            if (modeInfo.mode === 'video') {
                logger_1.logger.info('   已经在视频生成模式');
                return;
            }
            logger_1.logger.info(`   ⚠️ 检测到 Agent 模式: '${modeInfo.text}'，需要切换到视频生成`);
            // 点击模式按钮打开下拉菜单
            await this._humanClick(modeInfo.cx, modeInfo.cy);
            await this._humanWait(1, 1.5);
            // 在下拉菜单中点击 "视频生成"
            const clicked = await this.page.evaluate(() => {
                // 查找下拉菜单中的 "视频生成" 选项
                const items = document.querySelectorAll('[class*="menu-item"], [class*="dropdown-item"], [class*="option"], li, [role="menuitem"], [role="option"]');
                for (const item of items) {
                    const text = item.textContent?.trim() || '';
                    if (text === '视频生成' || (text.includes('视频生成') && text.length < 10)) {
                        const rect = item.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            item.click();
                            return text;
                        }
                    }
                }
                // 回退：用 text 匹配
                const allEls = document.querySelectorAll('*');
                for (const el of allEls) {
                    const text = el.textContent?.trim() || '';
                    const rect = el.getBoundingClientRect();
                    if (text === '视频生成' && rect.width > 50 && rect.height > 20
                        && rect.height < 60 && rect.top < window.innerHeight) {
                        el.click();
                        return text;
                    }
                }
                return null;
            });
            if (clicked) {
                logger_1.logger.info(`   ✅ 已切换到视频生成模式`);
                await this._humanWait(2, 3);
            }
            else {
                logger_1.logger.warn('   ⚠️ 下拉菜单中未找到 "视频生成" 选项');
                // 尝试用 Playwright locator 点击
                try {
                    await this.page.locator('text=视频生成').first().click({ timeout: 3000 });
                    logger_1.logger.info('   ✅ 已通过 locator 切换到视频生成模式');
                    await this._humanWait(2, 3);
                }
                catch (e2) {
                    logger_1.logger.warn(`   ⚠️ locator 点击也失败: ${e2}`);
                }
            }
        }
        catch (e) {
            logger_1.logger.warn(`   ⚠️ 模式选择异常 (可能已在正确模式): ${e}`);
        }
    }
    /**
     * 选择模型
     */
    async _selectModel(modelName = 'Seedance 2.0') {
        logger_1.logger.info(`🤖 选择模型: ${modelName}...`);
        try {
            if (await this._verifyModel(modelName)) {
                logger_1.logger.info(`   ✅ 当前已是 ${modelName}，无需切换`);
                return;
            }
            const currentUrl = this.page.url();
            if (!currentUrl.includes('generate')) {
                logger_1.logger.warn('   ⚠️ 不在生成页面，跳过模型选择');
                return;
            }
            // 用 JS 找到模型按钮 - 优先使用 select-view-value 选择器
            const btnInfo = await this.page.evaluate(() => {
                // 方法1: 精确匹配 lv-select 组件中的模型选择器
                const selectViews = document.querySelectorAll('.lv-select-view-value, [class*="select-view-value"]');
                for (const el of selectViews) {
                    const text = el.textContent?.trim() || '';
                    if (text.includes('Seedance') && !text.includes('Agent') && !text.includes('创作模式')) {
                        const rect = el.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            const selectTrigger = el.closest('.lv-select, [class*="lv-select"]') || el;
                            const triggerRect = selectTrigger.getBoundingClientRect();
                            return {
                                text,
                                cx: triggerRect.x + triggerRect.width / 2,
                                cy: triggerRect.y + triggerRect.height / 2,
                            };
                        }
                    }
                }
                // 方法2: 回退到扫描所有元素
                const vh = window.innerHeight;
                const allEls = document.querySelectorAll('*');
                for (const el of allEls) {
                    const rect = el.getBoundingClientRect();
                    if (rect.top > vh * 0.7 && rect.width > 50 && rect.width < 300
                        && rect.height > 15 && rect.height < 60) {
                        const text = el.textContent?.trim() || '';
                        if ((text.includes('3.0') || text.includes('3.5') || text.includes('Seedance')
                            || text.includes('2.0') || text.includes('Fast') || text.includes('Pro'))
                            && text.length > 3 && text.length < 30
                            && !text.includes('重新编辑') && !text.includes('描述')
                            && !text.includes('Agent') && !text.includes('创作模式')
                            && !text.includes('详细信息')) {
                            return {
                                text,
                                cx: rect.x + rect.width / 2,
                                cy: rect.y + rect.height / 2,
                            };
                        }
                    }
                }
                return null;
            });
            if (!btnInfo) {
                logger_1.logger.warn('   ⚠️ 未找到模型按钮');
                return;
            }
            logger_1.logger.info(`   找到模型按钮: '${btnInfo.text}' @ (${btnInfo.cx.toFixed(0)}, ${btnInfo.cy.toFixed(0)})`);
            // 点击打开下拉菜单
            await this._humanClick(btnInfo.cx, btnInfo.cy);
            await this._humanWait(1.5, 2.0);
            // 在下拉菜单中选择目标模型
            const clicked = await this.page.evaluate((targetModel) => {
                const normalizeModelText = (text) => {
                    return (text || '')
                        .replace(/\s+/g, ' ')
                        .replace(/（/g, '(')
                        .replace(/）/g, ')')
                        .trim();
                };
                const getModelVariant = (text) => {
                    const normalized = normalizeModelText(text);
                    if (!normalized.includes('Seedance 2.0')) {
                        return null;
                    }
                    if (normalized.includes('Fast VIP')) {
                        return 'fast-vip';
                    }
                    if (normalized.includes('Fast')) {
                        return 'fast';
                    }
                    if (normalized.includes('VIP')) {
                        return 'vip';
                    }
                    return 'base';
                };
                const options = document.querySelectorAll('[class*="lv-select-option"]');
                const targetVariant = getModelVariant(targetModel);
                for (const opt of options) {
                    const rect = opt.getBoundingClientRect();
                    if (rect.width <= 0 || rect.height <= 0)
                        continue;
                    const text = opt.textContent?.trim() || '';
                    const optVariant = getModelVariant(text);
                    if (optVariant === targetVariant && normalizeModelText(text).startsWith(normalizeModelText(targetModel))) {
                        opt.click();
                        return text;
                    }
                }
                return null;
            }, modelName);
            if (clicked) {
                logger_1.logger.info(`   ✅ 已点击 ${clicked}`);
                await this._humanWait(2, 3);
            }
            else {
                logger_1.logger.warn(`   ⚠️ 下拉菜单中未找到 '${modelName}'`);
            }
        }
        catch (e) {
            logger_1.logger.warn(`   ⚠️ 模型选择异常: ${e}`);
        }
    }
    /**
     * 验证当前选中的模型
     */
    async _verifyModel(expectedModel) {
        try {
            const current = await this.page.evaluate(() => {
                const vh = window.innerHeight;
                const selectViews = document.querySelectorAll('.lv-select-view-value, [class*="select-view-value"]');
                for (const el of selectViews) {
                    const text = el.textContent?.trim() || '';
                    if (text.includes('Seedance')) {
                        return text;
                    }
                }
                const labels = document.querySelectorAll('span[class*="label-"]');
                for (const el of labels) {
                    const text = el.textContent?.trim() || '';
                    const rect = el.getBoundingClientRect();
                    if (rect.top > vh * 0.5 && text.includes('Seedance')) {
                        return text;
                    }
                }
                return null;
            });
            logger_1.logger.info(`   🔍 当前模型: '${current}'`);
            if (current) {
                const normalizeModelText = (text) => (text || '')
                    .replace(/\s+/g, ' ')
                    .replace(/（/g, '(')
                    .replace(/）/g, ')')
                    .trim();
                const getModelVariant = (text) => {
                    const normalized = normalizeModelText(text);
                    if (!normalized.includes('Seedance 2.0')) {
                        return null;
                    }
                    if (normalized.includes('Fast VIP')) {
                        return 'fast-vip';
                    }
                    if (normalized.includes('Fast')) {
                        return 'fast';
                    }
                    if (normalized.includes('VIP')) {
                        return 'vip';
                    }
                    return 'base';
                };
                if (getModelVariant(current) === getModelVariant(expectedModel))
                    return true;
            }
            return false;
        }
        catch (e) {
            logger_1.logger.warn(`   验证模型异常: ${e}`);
            return false;
        }
    }
    /**
     * 选择时长
     */
    async _selectDuration(duration) {
        logger_1.logger.info(`⏱️ 选择时长: ${duration}s...`);
        try {
            const durationText = `${duration}s`;
            // 用 JS 找到当前时长按钮 (优先用 lv-select-view-value)
            const btnInfo = await this.page.evaluate(() => {
                const vh = window.innerHeight;
                // 方法1: 精确查找 lv-select 组件中的时长选择器
                const selectViews = document.querySelectorAll('.lv-select-view-value, [class*="select-view-value"]');
                for (const el of selectViews) {
                    const text = el.textContent?.trim() || '';
                    if (/^\d+s$/.test(text)) {
                        const rect = el.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            const selectTrigger = el.closest('.lv-select, [class*="lv-select"]') || el;
                            const triggerRect = selectTrigger.getBoundingClientRect();
                            return { text, cx: triggerRect.x + triggerRect.width / 2, cy: triggerRect.y + triggerRect.height / 2 };
                        }
                    }
                }
                // 方法2: 扫描底部元素
                const allEls = document.querySelectorAll('*');
                for (const el of allEls) {
                    const rect = el.getBoundingClientRect();
                    if (rect.top > vh * 0.7 && rect.height > 10 && rect.height < 60
                        && rect.width > 15 && rect.width < 100) {
                        const text = el.textContent?.trim() || '';
                        if (/^\d+s$/.test(text)) {
                            return { text, cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2 };
                        }
                    }
                }
                return null;
            });
            if (!btnInfo) {
                logger_1.logger.warn('   ⚠️ 未找到时长按钮');
                return;
            }
            const currentDuration = btnInfo.text;
            logger_1.logger.info(`   📎 当前时长: ${currentDuration}`);
            if (currentDuration === durationText) {
                logger_1.logger.info(`   ✅ 当前已是 ${durationText}，无需切换`);
                return;
            }
            // 点击打开下拉菜单
            await this._humanClick(btnInfo.cx, btnInfo.cy);
            await this._humanWait(1.0, 1.5);
            // 在下拉菜单中选择目标时长 (用 evaluate 确保可靠性)
            const clicked = await this.page.evaluate((target) => {
                const options = document.querySelectorAll('[class*="lv-select-option"], [class*="select-option"], [role="option"]');
                for (const opt of options) {
                    const rect = opt.getBoundingClientRect();
                    if (rect.width <= 0 || rect.height <= 0) continue;
                    const text = opt.textContent?.trim() || '';
                    if (text.includes(target) && /^\d+s/.test(text)) {
                        opt.click();
                        return text;
                    }
                }
                return null;
            }, durationText);
            if (clicked) {
                await this._humanWait(0.5, 1.0);
                logger_1.logger.info(`   ✅ 已选择 ${durationText}`);
            }
            else {
                logger_1.logger.warn(`   ⚠️ 下拉菜单中未找到 '${durationText}'，尝试 locator 回退`);
                // 回退: 用 Playwright locator
                try {
                    const optionLoc = this.page.locator(`[class*="select-option"]:has-text("${durationText}")`);
                    if (await optionLoc.count() > 0 && await optionLoc.first().isVisible({ timeout: 2000 })) {
                        await optionLoc.first().click({ timeout: 3000 });
                        await this._humanWait(0.5, 1.0);
                        logger_1.logger.info(`   ✅ 已通过 locator 选择 ${durationText}`);
                    }
                    else {
                        logger_1.logger.warn(`   ❌ 时长切换失败: 下拉菜单中没有 '${durationText}' 选项`);
                    }
                }
                catch (e2) {
                    logger_1.logger.warn(`   ❌ 时长切换失败: ${e2}`);
                }
            }
        }
        catch (e) {
            logger_1.logger.warn(`   ⚠️ 时长选择异常: ${e}`);
        }
    }
    /**
     * 选择比例
     */
    async _selectRatio(ratio) {
        logger_1.logger.info(`📐 选择比例: ${ratio}...`);
        try {
            // 检查当前比例
            const current = await this.page.evaluate(() => {
                const vh = window.innerHeight;
                const buttons = document.querySelectorAll('button.lv-btn');
                const ratios = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
                for (const btn of buttons) {
                    const rect = btn.getBoundingClientRect();
                    if (rect.top < vh * 0.7 || rect.width <= 0)
                        continue;
                    const text = btn.textContent?.trim() || '';
                    if (ratios.includes(text))
                        return text;
                }
                return null;
            });
            if (current === ratio) {
                logger_1.logger.info(`   ✅ 已是 ${ratio}，无需切换`);
                return;
            }
            // 点击展开比例选择器
            await this.page.evaluate(() => {
                const vh = window.innerHeight;
                const buttons = document.querySelectorAll('button.lv-btn');
                const ratios = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
                for (const btn of buttons) {
                    const rect = btn.getBoundingClientRect();
                    if (rect.top < vh * 0.7 || rect.width <= 0)
                        continue;
                    const text = btn.textContent?.trim() || '';
                    if (ratios.includes(text)) {
                        btn.click();
                        return text;
                    }
                }
                return null;
            });
            await this._humanWait(0.4, 0.6);
            // 选择目标比例
            const clicked = await this.page.evaluate((targetRatio) => {
                const radios = document.querySelectorAll('label.lv-radio');
                for (const radio of radios) {
                    const rect = radio.getBoundingClientRect();
                    if (rect.width <= 0 || rect.height <= 0)
                        continue;
                    const text = radio.textContent?.trim() || '';
                    if (text === targetRatio) {
                        radio.click();
                        return text;
                    }
                }
                return null;
            }, ratio);
            if (clicked) {
                logger_1.logger.info(`   ✅ 已选择 ${ratio}`);
            }
            else {
                logger_1.logger.warn(`   ⚠️ 未找到比例选项 ${ratio}`);
            }
            await this._humanWait(0.2, 0.3);
            await this.page.mouse.click(100, 300);
            await this._humanWait(0.3, 0.6);
        }
        catch (e) {
            logger_1.logger.warn(`   ⚠️ 比例选择异常: ${e}`);
        }
    }
    /**
     * 清理参考资源
     */
    async _clearReferenceResources(refMode = '全能参考') {
        logger_1.logger.info(`🧹 清理已有参考资源 (${refMode}模式)...`);
        try {
            const cleared = await this.page.evaluate(() => {
                const vh = window.innerHeight;
                let count = 0;
                const closeButtons = document.querySelectorAll('[class*="reference"] [class*="close"], ' +
                    '[class*="reference"] [class*="delete"], ' +
                    '[class*="upload-item"] [class*="close"], ' +
                    '[class*="material-item"] [class*="close"]');
                for (const btn of closeButtons) {
                    const rect = btn.getBoundingClientRect();
                    if (rect.top > vh * 0.4 && rect.width > 0 && rect.height > 0) {
                        btn.click();
                        count++;
                    }
                }
                return count;
            });
            if (cleared > 0) {
                logger_1.logger.info(`   ✅ 已清理 ${cleared} 个参考资源`);
                await this._humanWait(0.5, 1);
            }
            else {
                logger_1.logger.info('   ℹ️ 无需清理，未发现已有资源');
            }
        }
        catch (e) {
            logger_1.logger.warn(`   ⚠️ 清理参考资源异常: ${e}`);
        }
    }
    /**
     * 上传参考资源（图片/视频/音频）
     * @param imageUrl 资源URL，多个用逗号分隔
     * @param refMode 参考模式
     * @param taskId 任务ID（可选，用于错误回报）
     */
    async _uploadReferenceImage(imageUrl, refMode = '首尾帧', taskId) {
        const urls = imageUrl.split(',').map(u => u.trim()).filter(u => u);
        if (urls.length === 0)
            return [];
        logger_1.logger.info(`🖼️ 上传参考资源: ${urls.length} 个 (${refMode}模式)`);
        const tmpFiles = [];
        const resourceTypes = [];
        const downloadedResources = [];
        const imageExtSet = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
        const videoExtSet = new Set(['.mp4', '.mov', '.webm', '.avi', '.mkv', '.m4v']);
        const audioExtSet = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus']);
        const normalizeUrlExt = (rawUrl) => {
            try {
                const pathname = new URL(rawUrl).pathname.toLowerCase();
                const match = pathname.match(/\.[a-z0-9]+$/);
                return match ? match[0] : '';
            }
            catch {
                const stripped = rawUrl.split('?')[0].split('#')[0].toLowerCase();
                const match = stripped.match(/\.[a-z0-9]+$/);
                return match ? match[0] : '';
            }
        };
        try {
            // 下载所有资源到临时目录
            for (let idx = 0; idx < urls.length; idx++) {
                const url = urls[idx];
                logger_1.logger.info(`   📥 下载第 ${idx + 1}/${urls.length} 个: ${url.substring(0, 60)}...`);
                try {
                    const resp = await axios_1.default.get(url, { responseType: 'arraybuffer', timeout: 120000 });
                    const ct = (resp.headers['content-type'] || '').toLowerCase();
                    const urlExt = normalizeUrlExt(url);
                    let ext = '.png';
                    let fileType = '图片';
                    if (ct.includes('audio/') || audioExtSet.has(urlExt)) {
                        fileType = '音频';
                        if (ct.includes('audio/wav'))
                            ext = '.wav';
                        else if (ct.includes('audio/flac'))
                            ext = '.flac';
                        else if (ct.includes('audio/ogg'))
                            ext = '.ogg';
                        else if (ct.includes('audio/aac'))
                            ext = '.aac';
                        else if (ct.includes('audio/m4a') || ct.includes('audio/mp4'))
                            ext = '.m4a';
                        else
                            ext = audioExtSet.has(urlExt) ? urlExt : '.mp3';
                    }
                    else if (ct.includes('video/') || videoExtSet.has(urlExt)) {
                        fileType = '视频';
                        if (ct.includes('video/webm'))
                            ext = '.webm';
                        else if (ct.includes('video/quicktime'))
                            ext = '.mov';
                        else
                            ext = videoExtSet.has(urlExt) ? urlExt : '.mp4';
                    }
                    else if (ct.includes('image/') || imageExtSet.has(urlExt)) {
                        fileType = '图片';
                        if (ct.includes('jpeg') || ct.includes('jpg'))
                            ext = '.jpg';
                        else if (ct.includes('webp'))
                            ext = '.webp';
                        else if (ct.includes('gif'))
                            ext = '.gif';
                        else if (ct.includes('bmp'))
                            ext = '.bmp';
                        else
                            ext = imageExtSet.has(urlExt) ? urlExt : '.png';
                    }
                    // 检查图片尺寸
                    if (fileType === '图片') {
                        const dimensions = getImageDimensions(Buffer.from(resp.data));
                        if (dimensions) {
                            logger_1.logger.info(`   📐 图片尺寸: ${dimensions.width} x ${dimensions.height}`);
                            // 检查是否超过6000
                            if (dimensions.width > 6000 || dimensions.height > 6000) {
                                const errorMsg = `图片尺寸不能超过6000 (当前: ${dimensions.width} x ${dimensions.height})`;
                                logger_1.logger.error(`   ❌ ${errorMsg}`);
                                // 清理已下载的临时文件
                                for (const tmp of tmpFiles) {
                                    try {
                                        fs.unlinkSync(tmp);
                                    }
                                    catch { }
                                }
                                // 回报错误给 task_server
                                if (taskId && this._onVideoErrorReceived) {
                                    logger_1.logger.info(`   📤 回报错误给 task_server: ${taskId}`);
                                    // 使用 taskId 作为 itemId，因为没有 external_task_id
                                    this._onVideoErrorReceived(taskId, taskId, errorMsg);
                                }
                                // 刷新页面
                                logger_1.logger.info(`   🔄 刷新页面...`);
                                await this.page.reload({ waitUntil: 'domcontentloaded' });
                                // 关闭页面
                                logger_1.logger.info(`   🔒 关闭页面...`);
                                await this.page.close();
                                // 抛出错误以中断处理
                                throw new Error(errorMsg);
                            }
                        }
                        else {
                            logger_1.logger.warn(`   ⚠️ 无法识别图片格式，跳过尺寸检查`);
                        }
                    }
                    resourceTypes.push(fileType);
                    const tmp = path.join(os.tmpdir(), `ref_${(0, uuid_1.v4)().substring(0, 8)}${ext}`);
                    fs.writeFileSync(tmp, resp.data);
                    tmpFiles.push(tmp);
                    downloadedResources.push({ path: tmp, type: fileType });
                    logger_1.logger.info(`   ✅ 第 ${idx + 1} 个${fileType}已下载: ${tmp} (${(resp.data.length / 1024).toFixed(1)}KB)`);
                }
                catch (e) {
                    // 如果是尺寸错误，重新抛出
                    if (e instanceof Error && e.message.includes('图片尺寸不能超过6000')) {
                        throw e;
                    }
                    logger_1.logger.warn(`   ⚠️ 下载失败: ${e}`);
                    resourceTypes.push('');
                }
            }
            if (tmpFiles.length === 0) {
                logger_1.logger.warn('   ⚠️ 无有效参考资源可上传');
                return resourceTypes;
            }
            // 上传图片
            const fileInputs = this.page.locator('input[type="file"]');
            const count = await fileInputs.count();
            logger_1.logger.info(`   🔍 找到 ${count} 个 input[type=file], 资源数量: ${downloadedResources.length}`);
            if (refMode === '全能参考') {
                const uploadResources = downloadedResources.slice(0, 5);
                const uploadCount = uploadResources.length;
                const uploadPaths = uploadResources.map(item => item.path);
                const summary = uploadResources.map(item => item.type).join('、');
                logger_1.logger.info(`   📷 全能参考模式，上传 ${uploadCount} 个参考内容 (${summary || '无'})`);
                if (count > 0) {
                    await fileInputs.first().setInputFiles(uploadPaths);
                    logger_1.logger.info(`   ✅ 已上传 ${uploadCount} 个参考内容`);
                    await this._humanWait(3, 5);
                }
            }
            else {
                // 首尾帧模式
                const imageResources = downloadedResources
                    .filter(item => item.type === '图片')
                    .slice(0, 2);
                if (imageResources.length === 1) {
                    logger_1.logger.info('   📷 单张图片，上传到首帧');
                    await fileInputs.first().setInputFiles(imageResources[0].path);
                    logger_1.logger.info('   ✅ 首帧已上传');
                    await this._humanWait(3, 5);
                }
                else if (imageResources.length >= 2 && count >= 2) {
                    logger_1.logger.info('   📷 2张图片，上传首帧+尾帧');
                    await fileInputs.nth(1).setInputFiles(imageResources[1].path);
                    logger_1.logger.info('   ✅ 尾帧已上传');
                    await this._humanWait(2, 3);
                    await fileInputs.nth(0).setInputFiles(imageResources[0].path);
                    logger_1.logger.info('   ✅ 首帧已上传');
                    await this._humanWait(2, 3);
                }
                else if (imageResources.length === 0) {
                    logger_1.logger.warn('   ⚠️ 首尾帧模式未发现可用图片，跳过上传');
                }
            }
        }
        catch (e) {
            logger_1.logger.warn(`   ⚠️ 参考图上传异常: ${e}`);
        }
        finally {
            // 清理临时文件
            for (const tmp of tmpFiles) {
                try {
                    fs.unlinkSync(tmp);
                }
                catch { }
            }
        }
        return resourceTypes;
    }
    /**
     * 构建 @refX -> 资源名称 的映射
     */
    _buildRefMapping(resourceTypes) {
        let imageCount = 0;
        let videoCount = 0;
        let audioCount = 0;
        const refMapping = {};
        for (let idx = 0; idx < resourceTypes.length; idx++) {
            const resType = resourceTypes[idx];
            if (resType === '图片') {
                imageCount++;
                refMapping[`@ref${idx}`] = `图片${imageCount}`;
            }
            else if (resType === '视频') {
                videoCount++;
                refMapping[`@ref${idx}`] = `视频${videoCount}`;
            }
            else if (resType === '音频') {
                audioCount++;
                refMapping[`@ref${idx}`] = `音频${audioCount}`;
            }
            else {
                refMapping[`@ref${idx}`] = null;
            }
        }
        return refMapping;
    }
    /**
     * 安全地输入文本，换行符用 Shift+Enter 代替普通 Enter
     */
    async _safeTypeText(text) {
        if (!text)
            return;
        const parts = text.split('\n');
        for (let i = 0; i < parts.length; i++) {
            if (parts[i]) {
                await this.page.keyboard.type(parts[i], { delay: 10 });
            }
            if (i < parts.length - 1) {
                await this.page.keyboard.press('Shift+Enter');
                await this._humanWait(0.05, 0.1);
            }
        }
    }
    /**
     * 生成 @ 引用候选名称（兼容中英文与不同命名）
     */
    _buildAtReferenceCandidates(targetName) {
        const raw = (targetName || '').trim();
        if (!raw) {
            return [];
        }
        const candidates = [raw];
        const audioMatch = raw.match(/^音频(\d+)$/);
        const imageMatch = raw.match(/^图片(\d+)$/);
        const videoMatch = raw.match(/^视频(\d+)$/);
        if (audioMatch) {
            const idx = audioMatch[1];
            candidates.push(`音频 ${idx}`, `声音${idx}`, `声音 ${idx}`, `音乐${idx}`, `音乐 ${idx}`, `音效${idx}`, `音效 ${idx}`);
            candidates.push(`Audio ${idx}`, `audio ${idx}`, `audio${idx}`);
        }
        else if (imageMatch) {
            const idx = imageMatch[1];
            candidates.push(`图片 ${idx}`, `图像${idx}`, `图像 ${idx}`);
            candidates.push(`Image ${idx}`, `image ${idx}`, `image${idx}`);
        }
        else if (videoMatch) {
            const idx = videoMatch[1];
            candidates.push(`视频 ${idx}`, `Video ${idx}`, `video ${idx}`, `video${idx}`);
        }
        // 去重并移除空字符串
        const deduped = [];
        const seen = new Set();
        for (const candidate of candidates) {
            const value = candidate.trim();
            if (!value)
                continue;
            if (!seen.has(value)) {
                seen.add(value);
                deduped.push(value);
            }
        }
        return deduped;
    }
    /**
     * 在 @ 弹出选择器中选择指定资源
     */
    async _selectAtReference(targetName) {
        try {
            await this._humanWait(0.3, 0.5);
            const targets = Array.isArray(targetName)
                ? targetName.map(t => (t || '').trim()).filter(Boolean)
                : [(targetName || '').trim()].filter(Boolean);
            if (targets.length === 0) {
                logger_1.logger.warn('      ⚠️ @ 候选为空，跳过选择');
                return false;
            }
            const clicked = await this.page.evaluate((targetList) => {
                const selectors = [
                    '.lv-select-option',
                    '[class*="select-option"]',
                    '[class*="dropdown-item"]',
                    '[role="option"]',
                    '[class*="mention-item"]',
                    '[class*="at-item"]'
                ];
                const allOptions = [];
                for (const sel of selectors) {
                    const options = document.querySelectorAll(sel);
                    for (const opt of options) {
                        const text = opt.textContent?.trim() || '';
                        allOptions.push(text);
                        const textNorm = text.replace(/\s+/g, '').toLowerCase();
                        for (const target of targetList) {
                            const targetNorm = target.replace(/\s+/g, '').toLowerCase();
                            if (!targetNorm)
                                continue;
                            if (text.includes(target) || textNorm.includes(targetNorm)) {
                                opt.click();
                                return { clicked: text, matched: target, options: allOptions };
                            }
                        }
                    }
                }
                return { clicked: null, options: allOptions };
            }, targets);
            if (clicked?.clicked) {
                await this._humanWait(0.3, 0.5);
                logger_1.logger.info(`      ✅ 已选择 @ 引用: ${clicked.matched || targets[0]} (匹配: ${clicked.clicked})`);
                return true;
            }
            logger_1.logger.warn(`      ⚠️ 未找到 @ 选项: ${targets.join(' | ')}, 可用: ${(clicked?.options || []).slice(0, 8).join(', ')}`);
            return false;
        }
        catch (e) {
            logger_1.logger.warn(`      ⚠️ @ 选择失败: ${e}`);
            return false;
        }
    }
    /**
     * 输入带 @refX 占位符的提示词
     */
    async _typePromptWithRefs(prompt, refMapping) {
        logger_1.logger.info('⌨️ 输入提示词 (含 @ 引用)...');
        // 定位输入框
        let textarea = null;
        for (const sel of ['textarea.lv-textarea', 'textarea[class*="prompt"]', 'textarea']) {
            try {
                const loc = this.page.locator(sel).first();
                if (await loc.isVisible({ timeout: 2000 })) {
                    textarea = loc;
                    break;
                }
            }
            catch { }
        }
        if (!textarea) {
            logger_1.logger.warn('   ⚠️ 未找到输入框，使用 JS 查找');
            const found = await this.page.evaluate(() => {
                const vh = window.innerHeight;
                const inputs = document.querySelectorAll('textarea, [contenteditable="true"]');
                for (const inp of inputs) {
                    const rect = inp.getBoundingClientRect();
                    if (rect.top > vh * 0.5 && rect.width > 200) {
                        inp.focus();
                        return true;
                    }
                }
                return false;
            });
            if (!found) {
                logger_1.logger.warn('   ⚠️ JS 也未找到输入框');
                return;
            }
        }
        else {
            await textarea.click();
            await this._humanWait(0.3, 0.5);
        }
        // 清空输入框
        await this.page.keyboard.press('Control+a');
        await this.page.keyboard.press('Backspace');
        await this._humanWait(0.2, 0.4);
        // 解析 @refX 占位符
        const pattern = /@ref(\d+)/g;
        let lastEnd = 0;
        let match;
        let refCount = 0;
        while ((match = pattern.exec(prompt)) !== null) {
            // 输入 @refX 之前的文本
            const beforeText = prompt.slice(lastEnd, match.index);
            if (beforeText) {
                await this._safeTypeText(beforeText);
                await this._humanWait(0.1, 0.2);
            }
            // 处理 @refX
            const refKey = match[0];
            const targetName = refMapping[refKey];
            logger_1.logger.info(`      🔗 处理 ${refKey} -> ${targetName}`);
            if (targetName) {
                await this.page.keyboard.type('@');
                await this._humanWait(0.8, 1.2);
                const targetCandidates = this._buildAtReferenceCandidates(targetName);
                logger_1.logger.info(`      🔎 ${refKey} 候选引用: ${targetCandidates.join(' | ')}`);
                await this._selectAtReference(targetCandidates);
                // 重新聚焦并将光标移到末尾
                await this._humanWait(0.5, 0.8);
                await this.page.evaluate(() => {
                    const vh = window.innerHeight;
                    const inputs = document.querySelectorAll('textarea, [contenteditable="true"]');
                    for (const inp of inputs) {
                        const rect = inp.getBoundingClientRect();
                        if (rect.top > vh * 0.5 && rect.width > 200) {
                            inp.focus();
                            if (inp.tagName === 'TEXTAREA' || inp.tagName === 'INPUT') {
                                const el = inp;
                                el.selectionStart = el.selectionEnd = el.value.length;
                            }
                            else {
                                const range = document.createRange();
                                const sel = window.getSelection();
                                range.selectNodeContents(inp);
                                range.collapse(false);
                                sel?.removeAllRanges();
                                sel?.addRange(range);
                            }
                            return;
                        }
                    }
                });
                await this._humanWait(0.3, 0.5);
                refCount++;
                logger_1.logger.info(`      ✅ ${refKey} 处理完成`);
            }
            else {
                logger_1.logger.warn(`      ⚠️ ${refKey} 无映射，跳过`);
            }
            lastEnd = match.index + match[0].length;
            await this._humanWait(0.2, 0.4);
        }
        // 输入剩余文本
        const remaining = prompt.slice(lastEnd);
        if (remaining) {
            logger_1.logger.info(`   📝 输入剩余文本: ${remaining.slice(0, 50)}...`);
            await this._safeTypeText(remaining);
        }
        await this._humanWait(0.5, 1);
        logger_1.logger.info(`   ✅ 提示词已输入 (含 ${refCount} 个 @ 引用)`);
    }
    /**
     * 输入提示词
     */
    async _typePrompt(prompt) {
        logger_1.logger.info('⌨️ 输入提示词...');
        const inputSelectors = [
            'textarea[placeholder*="输入文字"]',
            'textarea[placeholder*="描述"]',
            '[class*="prompt-input"] textarea',
            '[class*="chat-input"] textarea',
            '[contenteditable="true"]',
            'textarea',
        ];
        let inputEl = null;
        for (const sel of inputSelectors) {
            try {
                const el = this.page.locator(sel).first();
                if (await el.isVisible({ timeout: 2000 })) {
                    inputEl = el;
                    break;
                }
            }
            catch { }
        }
        if (!inputEl) {
            throw new Error('找不到提示词输入框');
        }
        await inputEl.click();
        await this._humanWait(0.3, 0.6);
        await this.page.keyboard.press('Control+a');
        await this.page.keyboard.press('Backspace');
        await this._humanWait(0.2, 0.5);
        await inputEl.fill(prompt);
        await this._humanWait(0.5, 1.5);
        logger_1.logger.info(`   ✅ 提示词已输入 (${prompt.length} 字符)`);
    }
    /**
     * 点击生成按钮
     */
    async _clickGenerate() {
        logger_1.logger.info('🚀 点击生成按钮...');
        const genSelectors = [
            'button:has-text("立即生成")',
            'button:has-text("生成")',
            '[class*="send-btn"]',
            '[class*="submit-btn"]',
            '[class*="generate-btn"]',
        ];
        for (const sel of genSelectors) {
            try {
                const btn = this.page.locator(sel).first();
                if (await btn.isVisible({ timeout: 1000 })) {
                    await btn.click();
                    await this._humanWait(1, 2);
                    logger_1.logger.info('   ✅ 已点击生成');
                    return;
                }
            }
            catch { }
        }
        // 备用: JS 查找
        const clicked = await this.page.evaluate(() => {
            const buttons = document.querySelectorAll('button, [role="button"]');
            let best = null;
            let bestX = 0;
            for (const btn of buttons) {
                const rect = btn.getBoundingClientRect();
                if (rect.top > window.innerHeight * 0.7 &&
                    rect.width > 0 && rect.height > 0 &&
                    rect.left > window.innerWidth * 0.3) {
                    if (rect.left > bestX) {
                        bestX = rect.left;
                        best = btn;
                    }
                }
            }
            if (best) {
                best.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                return true;
            }
            return false;
        });
        if (clicked) {
            await this._humanWait(1, 2);
            logger_1.logger.info('   ✅ 已点击生成 (JS)');
            return;
        }
        throw new Error('找不到生成按钮');
    }
    /**
     * 等待生成完成
     */
    async _waitForGeneration() {
        logger_1.logger.info('⏳ 等待视频生成完成 (最多60分钟)...');
        const startTime = Date.now();
        const timeoutMs = config.GEN_TIMEOUT;
        const oldDoneCount = await this.page.locator('text=重新编辑').count();
        logger_1.logger.info(`   页面已有 ${oldDoneCount} 个'重新编辑'按钮`);
        await sleep(5000);
        const checkInterval = 10000;
        while (Date.now() - startTime < timeoutMs) {
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            try {
                const newDoneCount = await this.page.locator('text=重新编辑').count();
                if (newDoneCount > oldDoneCount) {
                    logger_1.logger.info(`   ✅ 视频生成完成！(耗时 ${elapsed}s)`);
                    logger_1.logger.info('🔄 生成完成，准备刷新页面获取视频URL');
                    // 查找当前页面对应的任务槽位并标记为完成
                    const currentSlot = this._findSlotByPage(this.page);
                    if (currentSlot) {
                        logger_1.logger.info(`   📝 找到对应任务槽位: ${currentSlot.taskId}，准备标记任务完成`);
                    }
                    else {
                        logger_1.logger.debug(`   🔍 未找到当前页面对应的任务槽位`);
                    }
                    // 刷新页面以触发资产列表API调用
                    logger_1.logger.info('🔄 开始刷新页面以触发资产列表API...');
                    try {
                        const currentUrl = this.page.url();
                        logger_1.logger.debug(`   📍 刷新前页面URL: ${currentUrl}`);
                        await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
                        const reloadedUrl = this.page.url();
                        logger_1.logger.info(`   ✅ 页面刷新完成，刷新后URL: ${reloadedUrl}`);
                        logger_1.logger.info('   ⏳ 等待资产列表API响应...');
                        // 短暂等待确保API响应能够被捕获
                        await this._humanWait(2, 3);
                        logger_1.logger.info('   🎯 页面刷新完成，任务处理结束');
                    }
                    catch (e) {
                        logger_1.logger.error(`   ❌ 页面刷新失败: ${e}`);
                        logger_1.logger.warn(`   ⚠️ 刷新失败，但仍继续处理`);
                        // 即使刷新失败，也短暂等待尝试捕获可能的API响应
                        await this._humanWait(1, 2);
                    }
                    // 标记任务完成并关闭页面（不等待视频URL处理）
                    logger_1.logger.info('🔄 任务完成，准备关闭页面');
                    await this._markTaskCompleted(this.page);
                    return true;
                }
            }
            catch (e) {
                logger_1.logger.debug(`   检测异常: ${e}`);
            }
            try {
                const f1 = await this.page.locator('text=生成失败').count();
                const f2 = await this.page.locator('text=任务失败').count();
                const f3 = await this.page.locator('text=请重试').count();
                if (f1 > 0 || f2 > 0 || f3 > 0) {
                    logger_1.logger.error('   ❌ 即梦返回生成失败');
                    return false;
                }
            }
            catch { }
            if (elapsed % 60 === 0 && elapsed > 0) {
                logger_1.logger.info(`   ⏳ 已等待 ${elapsed}s...`);
            }
            await sleep(checkInterval);
        }
        logger_1.logger.error(`   ❌ 等待超时 (${timeoutMs / 1000}s)`);
        return false;
    }
    /**
     * 获取视频URL
     */
    async _getVideoUrl(excludeUrls) {
        const exclude = excludeUrls || new Set();
        logger_1.logger.info(`🔗 获取视频URL... (排除 ${exclude.size} 个旧URL)`);
        try {
            const excludeList = Array.from(exclude);
            const videoSrc = await this.page.evaluate((excludeArr) => {
                const excludeSet = new Set(excludeArr);
                const videos = document.querySelectorAll('video');
                const results = [];
                for (const v of videos) {
                    let src = v.src || '';
                    if (!src) {
                        const source = v.querySelector('source');
                        if (source)
                            src = source.src || '';
                    }
                    if (src)
                        results.push(src);
                }
                for (const url of results) {
                    if (url.includes('loading') || url.includes('animation') || url.includes('static/media'))
                        continue;
                    if (url.startsWith('blob:'))
                        continue;
                    if (excludeSet.has(url))
                        continue;
                    return url;
                }
                return null;
            }, excludeList);
            if (videoSrc && !videoSrc.startsWith('blob:')) {
                const finalUrl = videoSrc.startsWith('//') ? 'https:' + videoSrc : videoSrc;
                logger_1.logger.info(`   ✅ 获取视频URL: ${finalUrl.substring(0, 100)}...`);
                return finalUrl;
            }
        }
        catch (e) {
            logger_1.logger.warn(`   获取视频URL失败: ${e}`);
        }
        logger_1.logger.error('   ❌ 无法获取视频URL');
        return null;
    }
    /**
     * 收集所有视频URL
     */
    async _collectAllVideoUrls() {
        try {
            const urls = await this.page.evaluate(() => {
                const urlSet = new Set();
                document.querySelectorAll('video').forEach(v => {
                    if (v.src && !v.src.startsWith('blob:'))
                        urlSet.add(v.src);
                    const source = v.querySelector('source');
                    if (source && source.src && !source.src.startsWith('blob:'))
                        urlSet.add(source.src);
                });
                performance.getEntriesByType('resource').forEach(e => {
                    if ((e.name.includes('.mp4') || e.name.includes('video'))
                        && e.name.startsWith('http')) {
                        urlSet.add(e.name);
                    }
                });
                return Array.from(urlSet);
            });
            return new Set(urls || []);
        }
        catch (e) {
            logger_1.logger.warn(`   收集视频URL异常: ${e}`);
            return new Set();
        }
    }
    // ==========================================
    // 🎭 真人模拟工具方法
    // ==========================================
    async _humanWait(minSec, maxSec) {
        await sleep(randomUniform(minSec, maxSec) * 1000);
    }
    async _humanPause() {
        const r = Math.random();
        if (r < 0.3) {
            await sleep(randomUniform(0.3, 0.8) * 1000);
        }
        else if (r < 0.7) {
            await sleep(randomUniform(1.0, 3.0) * 1000);
        }
        else if (r < 0.9) {
            await sleep(randomUniform(3.0, 6.0) * 1000);
        }
        else {
            await sleep(randomUniform(6.0, 15.0) * 1000);
        }
    }
    /**
     * 三阶贝塞尔曲线生成路径点
     */
    _bezierCurve(p0, p1, p2, p3, numPoints = 30) {
        const points = [];
        for (let i = 0; i <= numPoints; i++) {
            const t = i / numPoints;
            const invT = 1 - t;
            const x = invT ** 3 * p0[0] + 3 * invT ** 2 * t * p1[0] +
                3 * invT * t ** 2 * p2[0] + t ** 3 * p3[0];
            const y = invT ** 3 * p0[1] + 3 * invT ** 2 * t * p1[1] +
                3 * invT * t ** 2 * p2[1] + t ** 3 * p3[1];
            points.push([x, y]);
        }
        return points;
    }
    /**
     * 贝塞尔曲线模拟真人鼠标移动
     */
    async _humanMove(targetX, targetY) {
        let startX = 0, startY = 0;
        try {
            const current = await this.page.evaluate(() => {
                return window.__lastMousePos || { x: 0, y: 0 };
            });
            startX = current.x || 0;
            startY = current.y || 0;
        }
        catch { }
        const dist = Math.sqrt((targetX - startX) ** 2 + (targetY - startY) ** 2);
        if (dist < 5) {
            await this.page.mouse.move(targetX, targetY);
            return;
        }
        const numSteps = Math.max(15, Math.min(50, Math.floor(dist / 15)));
        const offsetScale = dist * randomUniform(0.1, 0.35);
        const direction = Math.random() < 0.5 ? -1 : 1;
        const dx = targetX - startX;
        const dy = targetY - startY;
        const norm = Math.sqrt(dx ** 2 + dy ** 2) || 1;
        const nx = -dy / norm;
        const ny = dx / norm;
        const ctrl1 = [
            startX + dx * 0.3 + nx * offsetScale * direction * randomUniform(0.5, 1.2),
            startY + dy * 0.3 + ny * offsetScale * direction * randomUniform(0.5, 1.2)
        ];
        const ctrl2 = [
            startX + dx * 0.7 + nx * offsetScale * direction * randomUniform(0.3, 0.8),
            startY + dy * 0.7 + ny * offsetScale * direction * randomUniform(0.3, 0.8)
        ];
        const points = this._bezierCurve([startX, startY], ctrl1, ctrl2, [targetX, targetY], numSteps);
        for (let i = 0; i < points.length; i++) {
            const [px, py] = points[i];
            const jitterX = randomGauss(0, 0.5);
            const jitterY = randomGauss(0, 0.5);
            await this.page.mouse.move(px + jitterX, py + jitterY);
            const progress = i / Math.max(points.length - 1, 1);
            const speedFactor = 0.3 + 0.7 * Math.sin(progress * Math.PI);
            const baseDelay = randomUniform(0.005, 0.015);
            await sleep(baseDelay * 1000 / Math.max(speedFactor, 0.1));
        }
        await this.page.mouse.move(targetX, targetY);
    }
    /**
     * 贝塞尔曲线移动 + 点击
     */
    async _humanClick(x, y) {
        await this._humanMove(x, y);
        await sleep(randomUniform(0.05, 0.2) * 1000);
        await this.page.mouse.click(x, y);
    }
    /**
     * 贝塞尔曲线移动 + mousedown/mouseup 分离事件 (用于某些 React 组件)
     */
    async _humanMousedownUp(x, y) {
        await this._humanMove(x, y);
        await sleep(randomUniform(0.05, 0.15) * 1000);
        await this.page.mouse.down();
        await sleep(randomUniform(0.06, 0.15) * 1000);
        await this.page.mouse.up();
    }
    /**
     * 注入低资源优化
     */
    async _injectOptimizer(page) {
        try {
            await page.addStyleTag({
                content: `
                    *, *::before, *::after {
                        animation: none !important;
                        transition: none !important;
                    }
                `
            });
            logger_1.logger.info('   ⚡ 已注入低资源优化');
        }
        catch (e) {
            logger_1.logger.warn(`   注入优化失败: ${e}`);
        }
    }
}
exports.BrowserEngine = BrowserEngine;
