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
exports.ConcurrentBrowserEngine = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const config = __importStar(require("./config"));
const logger_1 = require("./logger");
const browser_engine_1 = require("./browser_engine");
// 工具函数
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
/**
 * 支持多任务并发的浏览器引擎
 * 核心思路: 同一浏览器内开多个 tab (Page)，每个 tab 独立跑一个生成任务
 * 主线程单线程轮询，无需多线程，避免 Playwright 线程安全问题
 */
class ConcurrentBrowserEngine extends browser_engine_1.BrowserEngine {
    activeSlots = [];
    _maxSlots = 0;
    _modelConfirmed = false;
    _lastConfirmedModel = null;
    _downloadedUrls = new Set();
    _mainRefreshTimer = null;
    _lastMainRefreshAt = 0;
    _mainRefreshIntervalMs = 60000;
    _isRefreshingMain = false;
    _slotNetworkIdleMs = 30000; // 30秒网络空闲
    _slotRefreshIntervalMs = 60000; // 60秒刷新间隔
    _assetProbeTimer = null;
    _assetProbeIntervalMs = 5 * 60 * 1000;
    _isAssetProbing = false;
    _globalCooldownUntil = 0; // 全局冷静时间戳
    constructor() {
        super();
    }
    /**
     * 合并任务中的参考资源字段（图片/音频/通用资源）
     */
    _mergeReferenceUrls(taskInfo) {
        const rawFields = [
            taskInfo.ref_resource_url,
            taskInfo.ref_media_url,
            taskInfo.ref_image_url,
            taskInfo.ref_audio_url,
        ].filter((value) => typeof value === 'string' && value.trim().length > 0);
        const merged = [];
        const seen = new Set();
        for (const field of rawFields) {
            const parts = field.split(',').map(part => part.trim()).filter(Boolean);
            for (const part of parts) {
                if (!seen.has(part)) {
                    seen.add(part);
                    merged.push(part);
                }
            }
        }
        return merged.join(',');
    }
    async start() {
        await super.start();
        this._maxSlots = config.MAX_CONCURRENT_TASKS || 10;
        logger_1.logger.info(`🔢 并发页面池已创建: ${this._maxSlots} 个槽位 (按需创建)`);
        // 独立定时刷新主页面，避免主循环阻塞导致刷新不及时
        this._mainRefreshTimer = setInterval(async () => {
            try {
                await this.refreshMainPage();
            }
            catch { }
        }, this._mainRefreshIntervalMs);
        // 定时触发资产列表探测，避免任务过多导致状态漏报
        this._assetProbeTimer = setInterval(async () => {
            try {
                await this._runAssetListProbe();
            }
            catch { }
        }, this._assetProbeIntervalMs);
    }
    /**
     * 设置视频URL接收回调
     */
    onVideoUrlReceived(callback) {
        this._onVideoUrlReceived = callback;
    }
    /**
     * 设置视频错误接收回调
     */
    onVideoErrorReceived(callback) {
        this._onVideoErrorReceived = callback;
    }
    hasFreeSlot() {
        return this.activeSlots.length < this._maxSlots && !this.isInGlobalCooldown();
    }
    isInGlobalCooldown() {
        return Date.now() < this._globalCooldownUntil;
    }
    getGlobalCooldownRemaining() {
        const remaining = this._globalCooldownUntil - Date.now();
        return Math.max(0, Math.floor(remaining / 1000));
    }
    /**
     * 获取槽位使用率
     */
    getSlotUtilization() {
        return this.activeSlots.length / this._maxSlots;
    }
    /**
     * 检查是否处于高槽位压力状态
     */
    isUnderHighPressure() {
        return this.getSlotUtilization() >= 0.8; // 80%以上使用率视为高压力
    }
    /**
     * 根据槽位压力调整释放策略
     */
    getDynamicTimeout() {
        if (this.isUnderHighPressure()) {
            // 高压力时使用较短但合理的超时，确保generate请求有足够时间
            return Math.max(45000, this._slotNetworkIdleMs * 1.5); // 最少45秒
        }
        return this._slotNetworkIdleMs;
    }
    setGlobalCooldown(minutes) {
        this._globalCooldownUntil = Date.now() + (minutes * 60 * 1000);
        logger_1.logger.warn(`🌍️ 设置全局冷静 ${minutes} 分钟，将在 ${new Date(this._globalCooldownUntil).toLocaleTimeString()} 解除`);
    }
    activeCount() {
        return this.activeSlots.length;
    }
    /**
     * 刷新主页面（初始页面）
     * 用于保持页面活跃和更新状态
     */
    async refreshMainPage() {
        let mainPage = this._mainPage || this.page;
        if (mainPage && mainPage.isClosed() && this.context) {
            const pages = this.context.pages().filter(p => !p.isClosed());
            mainPage = pages[0] || null;
            this._mainPage = mainPage;
        }
        if (!mainPage || mainPage.isClosed()) {
            logger_1.logger.warn('⚠️ 主页面不存在或已关闭，跳过刷新');
            return;
        }
        const now = Date.now();
        if (now - this._lastMainRefreshAt < this._mainRefreshIntervalMs - 1000) {
            return;
        }
        if (this._isRefreshingMain) {
            return;
        }
        this._isRefreshingMain = true;
        try {
            const currentUrl = mainPage.url();
            logger_1.logger.debug(`🔄 刷新主页面: ${currentUrl}`);
            // 使用 domcontentloaded 等待策略，快速刷新
            await mainPage.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
            // 重新注入优化脚本
            await this._injectOptimizer(mainPage);
            this._lastMainRefreshAt = now;
            logger_1.logger.debug('✅ 主页面刷新完成');
        }
        catch (e) {
            logger_1.logger.warn(`⚠️ 主页面刷新失败: ${e}`);
        }
        finally {
            this._isRefreshingMain = false;
        }
    }
    /**
     * 提交一个任务到空闲槽位
     */
    async submitTask(taskInfo) {
        if (!this.hasFreeSlot()) {
            logger_1.logger.warn('⚠️ 没有空闲槽位');
            return false;
        }
        const page = await this.context.newPage();
        await this._injectOptimizer(page);
        const originalPage = this.page;
        this.page = page;
        const taskId = taskInfo.task_id || taskInfo.id || '';
        try {
            const prompt = taskInfo.prompt || '';
            const duration = taskInfo.duration || 10;
            const ratio = taskInfo.ratio || '16:9';
            const refResourceUrls = this._mergeReferenceUrls(taskInfo);
            const modelRaw = taskInfo.model_type || 'seedance2.0';
            // 解析 -ref 后缀
            const useRefMode = modelRaw.toLowerCase().endsWith('-ref');
            const model = useRefMode ? modelRaw.slice(0, -4) : modelRaw;
            const refMode = useRefMode ? '全能参考' : '首尾帧';
            logger_1.logger.info(`📋 [${taskId}] 开始提交任务到槽位...`);
            logger_1.logger.info(`   📌 参考模式: ${refMode}, 原始model: ${modelRaw}`);
            // Step 0: 导航
            await this._navigateToGeneratePage();
            await this._humanPause();
            // Step 1: 选择视频生成模式
            await this._selectVideoMode();
            await this._humanPause();
            // Step 1.5: 切换参考模式 (对于全能参考模式，先切换模式以避免影响模型选择)
            if (refMode === '全能参考') {
                await this._selectReferenceMode(refMode);
                await this._humanPause();
            }
            // Step 2: 选择模型
            const targetModel = model && model.toLowerCase().includes('fast')
                ? 'Seedance 2.0 Fast'
                : 'Seedance 2.0';
            logger_1.logger.info(`🎯 [${taskId}] 目标模型: ${targetModel}`);
            // 如果模型变了，重置确认状态以使用完整的 _selectModel
            if (this._modelConfirmed && this._lastConfirmedModel !== targetModel) {
                logger_1.logger.info(`   🔄 模型需切换: ${this._lastConfirmedModel} → ${targetModel}，重置确认状态`);
                this._modelConfirmed = false;
            }
            if (!this._modelConfirmed) {
                await this._selectModel(targetModel);
                if (await this._verifyModel(targetModel)) {
                    this._modelConfirmed = true;
                    this._lastConfirmedModel = targetModel;
                }
                else {
                    logger_1.logger.warn(`⚠️ [${taskId}] 模型验证无法确认，继续尝试生成`);
                    // 不设置 _modelConfirmed，下次仍用完整选择逻辑
                }
            }
            else {
                await this._selectModelSilent(targetModel);
            }
            await this._humanPause();
            // Step 2.5: 如果不是全能参考模式，则在此处切换参考模式
            if (refMode !== '全能参考') {
                await this._selectReferenceMode(refMode);
                await this._humanPause();
            }
            // Step 3: 时长
            await this._selectDuration(duration);
            await this._humanPause();
            // Step 4: 参考图
            let resourceTypes = [];
            if (refResourceUrls) {
                await this._clearReferenceResources(refMode);
                logger_1.logger.info(`   📎 参考资源字段已合并: ${refResourceUrls.split(',').length} 个`);
                resourceTypes = await this._uploadReferenceImage(refResourceUrls, refMode, taskId);
                await this._humanPause();
            }
            // Step 5: 比例
            await this._selectRatio(ratio);
            await this._humanPause();
            // Step 6: 提示词 (带防串台标签)
            const taskTag = taskId.substring(0, 8); // 使用task_id前8位作为防串台标签
            const tagSuffix = `\n⟨⟩⟨${taskTag}⟩`;
            logger_1.logger.info(`   🏷️ [${taskId.substring(0, 8)}] 防串台标签: ⟨${taskTag}⟩`);
            // 判断是否需要使用 @refX 替换
            const hasRefPlaceholder = /@ref\d+/.test(prompt);
            if (refMode === '全能参考' && resourceTypes.length > 0 && hasRefPlaceholder) {
                const refMapping = this._buildRefMapping(resourceTypes);
                logger_1.logger.info(`   🔄 @ 引用映射: ${JSON.stringify(refMapping)}`);
                await this._typePromptWithRefs(prompt + tagSuffix, refMapping);
            }
            else {
                await this._typePrompt(prompt + tagSuffix);
            }
            // Step 6.5: 记录基准
            const oldVideoUrls = await this._collectAllVideoUrls();
            const oldDoneCount = await page.locator('text=重新编辑').count();
            logger_1.logger.info(`     防串台基准 (生成前): 已知视频URL=${oldVideoUrls.size}, 重新编辑=${oldDoneCount}`);
            // 创建槽位记录并立即添加到映射中，确保在生成请求发出前就能匹配
            const slot = new browser_engine_1.TaskSlot(page, taskInfo);
            slot.oldDoneCount = oldDoneCount;
            slot.oldVideoUrls = oldVideoUrls;
            slot.tag = taskTag;
            // 重要：在点击生成前就添加到映射，这样响应监听器才能找到槽位
            this._activeTaskSlots.set(taskTag, slot);
            this.activeSlots.push(slot);
            try {
                // Step 7: 点击生成
                await this._clickGenerate();
            }
            catch (clickError) {
                // 如果点击生成失败，清理映射避免内存泄漏
                this._activeTaskSlots.delete(taskTag);
                const index = this.activeSlots.indexOf(slot);
                if (index > -1) {
                    this.activeSlots.splice(index, 1);
                }
                throw clickError; // 重新抛出错误
            }
            logger_1.logger.info(`✅ [${taskId}] 任务已提交 (活跃: ${this.activeSlots.length}/${this._maxSlots}, 标签映射: ${this._activeTaskSlots.size})`);
            logger_1.logger.info(`   🏷️ 防串台标签: ${taskTag}, 任务ID: ${taskId}, 外部任务ID: ${taskInfo.external_task_id || '无'}`);
            return true;
        }
        catch (e) {
            logger_1.logger.error(`❌ [${taskId}] 提交任务异常: ${e}`);
            try {
                await page.close();
            }
            catch { }
            return false;
        }
        finally {
            if (originalPage && !originalPage.isClosed()) {
                this.page = originalPage;
            }
            else if (this._mainPage && !this._mainPage.isClosed()) {
                this.page = this._mainPage;
            }
            else if (this.context) {
                const pages = this.context.pages().filter(p => !p.isClosed());
                this.page = pages[0] || null;
                this._mainPage = this.page;
            }
        }
    }
    /**
     * 静默模型选择
     */
    async _selectModelSilent(modelName = 'Seedance 2.0') {
        logger_1.logger.info(`🤖 [${modelName}] 静默模型选择...`);
        try {
            // 不再提前验证，直接进行模型切换
            const currentUrl = this.page.url();
            if (!currentUrl.includes('generate')) {
                return;
            }
            // 用 JS 找模型按钮坐标 - 优先使用 select-view-value 选择器
            const btnInfo = await this.page.evaluate(() => {
                // 方法1: 精确匹配 lv-select 组件中的模型选择器
                const selectViews = document.querySelectorAll('.lv-select-view-value, [class*="select-view-value"]');
                for (const el of selectViews) {
                    const text = el.textContent?.trim() || '';
                    if (text.includes('Seedance') && !text.includes('Agent') && !text.includes('创作模式')) {
                        const rect = el.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            // 点击 select 的触发区域（向上找 lv-select 容器）
                            const selectTrigger = el.closest('.lv-select, [class*="lv-select"]') || el;
                            const triggerRect = selectTrigger.getBoundingClientRect();
                            return { cx: triggerRect.x + triggerRect.width / 2, cy: triggerRect.y + triggerRect.height / 2, text };
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
                        if ((text.includes('Seedance') || text.includes('3.0') || text.includes('3.5')
                            || text.includes('2.0') || text.includes('Fast') || text.includes('Pro'))
                            && text.length > 3 && text.length < 30
                            && !text.includes('重新编辑') && !text.includes('描述')
                            && !text.includes('Agent') && !text.includes('创作模式')
                            && !text.includes('详细信息')) {
                            return { cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2, text };
                        }
                    }
                }
                return null;
            });
            if (btnInfo) {
                logger_1.logger.info(`   当前模型按钮: '${btnInfo.text}', 目标模型: '${modelName}'`);
                await this._humanClick(btnInfo.cx, btnInfo.cy);
                await this._humanWait(1.5, 2.0);
                // 尝试在下拉菜单中选择
                const clicked = await this.page.evaluate((targetModel) => {
                    const options = document.querySelectorAll('[class*="lv-select-option"]');
                    const targetIsFast = targetModel.includes('Fast');
                    for (const opt of options) {
                        const rect = opt.getBoundingClientRect();
                        if (rect.width <= 0 || rect.height <= 0)
                            continue;
                        const text = opt.textContent?.trim() || '';
                        const optIsFast = text.includes('Fast');
                        // 精确匹配目标模型，区分Fast和非Fast版本
                        if (text.startsWith(targetModel) && targetIsFast === optIsFast) {
                            opt.click();
                            return text;
                        }
                    }
                    return null;
                }, modelName);
                if (clicked) {
                    await this._humanWait(2, 3);
                    logger_1.logger.info(`   ✅ 静默选择 ${modelName} 成功`);
                    // 再次验证模型是否正确切换
                    if (await this._verifyModel(modelName)) {
                        logger_1.logger.info(`   ✅ 模型验证成功: ${modelName}`);
                    }
                    else {
                        logger_1.logger.warn(`   ⚠️ 模型验证失败，实际可能仍为: ${btnInfo.text}`);
                    }
                    return;
                }
                else {
                    logger_1.logger.warn(`   ⚠️ 下拉菜单中未找到模型选项: ${modelName}`);
                }
            }
            else {
                logger_1.logger.warn('   ⚠️ 未找到模型按钮');
            }
            logger_1.logger.warn('   ⚠️ 静默模型选择失败，继续执行');
        }
        catch (e) {
            logger_1.logger.warn(`   ⚠️ 静默模型选择异常: ${e}`);
        }
    }
    /**
     * 切换参考模式
     */
    async _selectReferenceMode(mode = '首尾帧') {
        logger_1.logger.info(`🔄 切换参考模式: ${mode}...`);
        try {
            // 检查当前模式
            const currentMode = await this.page.evaluate(() => {
                const selectors = document.querySelectorAll('.lv-select-view-value, [class*="select-view-value"], [class*="feature-select"] span');
                for (const el of selectors) {
                    const text = el.textContent?.trim() || '';
                    if (text === '全能参考' || text === '首尾帧') {
                        return text;
                    }
                }
                return null;
            });
            logger_1.logger.info(`   📎 当前参考模式: ${currentMode}`);
            if (currentMode === mode) {
                logger_1.logger.info(`   ✅ 当前已是 ${mode} 模式`);
                return;
            }
            // 点击下拉菜单
            const triggerInfo = await this.page.evaluate(() => {
                const vh = window.innerHeight;
                const triggers = document.querySelectorAll('[class*="feature-select"], .lv-select-view-selector');
                for (const el of triggers) {
                    const rect = el.getBoundingClientRect();
                    if (rect.top < vh * 0.5 || rect.width <= 0)
                        continue;
                    const text = el.textContent?.trim() || '';
                    if (text === '首尾帧' || text === '全能参考') {
                        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text };
                    }
                }
                return null;
            });
            if (triggerInfo) {
                await this._humanClick(triggerInfo.x, triggerInfo.y);
                logger_1.logger.info(`   📂 已点击下拉触发器: '${triggerInfo.text}'`);
                await this._humanWait(1, 1.5);
                // 选择目标模式
                const selected = await this.page.evaluate((targetMode) => {
                    const options = document.querySelectorAll('.lv-select-option, [class*="lv-select-option"]');
                    for (const opt of options) {
                        const rect = opt.getBoundingClientRect();
                        if (rect.width <= 0 || rect.height <= 0)
                            continue;
                        const text = opt.textContent?.trim() || '';
                        if (text === targetMode) {
                            opt.click();
                            return text;
                        }
                    }
                    return null;
                }, mode);
                if (selected) {
                    logger_1.logger.info(`   ✅ 已选择 ${mode}`);
                    await this._humanWait(1, 2);
                }
                else {
                    logger_1.logger.warn(`   ⚠️ 下拉菜单中未找到 ${mode} 选项`);
                }
            }
        }
        catch (e) {
            logger_1.logger.warn(`   ⚠️ 参考模式切换异常: ${e}`);
        }
    }
    /**
     * 轮询所有活跃槽位
     */
    async pollActiveSlots() {
        if (this.activeSlots.length === 0) {
            return [];
        }
        const completed = [];
        const stillActive = [];
        for (const slot of this.activeSlots) {
            try {
                const result = await this._checkSlotStatus(slot);
                if (result) {
                    if (!result.closeOnly) {
                        completed.push(result);
                    }
                    else {
                        logger_1.logger.warn(`⏱️ [${slot.taskId}] 超时关闭：仅清理页面，不回传失败`);
                    }
                    // 从标签映射中移除已完成的任务
                    if (slot.tag) {
                        this._activeTaskSlots.delete(slot.tag);
                        logger_1.logger.debug(`   🏷️ 已从标签映射中移除任务: ${slot.tag}`);
                    }
                    try {
                        await slot.page.close();
                    }
                    catch { }
                }
                else {
                    stillActive.push(slot);
                }
            }
            catch (e) {
                logger_1.logger.error(`❌ [${slot.taskId}] 槽位检查异常: ${e}`);
                try {
                    await slot.page.reload();
                    logger_1.logger.debug(`🔄 [${slot.taskId}] 已刷新页面`);
                }
                catch { }
                // 从标签映射中移除失败的任务
                if (slot.tag) {
                    this._activeTaskSlots.delete(slot.tag);
                    logger_1.logger.debug(`   🏷️ 已从标签映射中移除失败任务: ${slot.tag}`);
                }
                try {
                    await slot.page.close();
                }
                catch { }
            }
        }
        this.activeSlots = stillActive;
        if (completed.length > 0) {
            logger_1.logger.info(`📊 轮询结果: ${completed.length} 完成, ${stillActive.length} 进行中, 空闲 ${this._maxSlots - stillActive.length}/${this._maxSlots}`);
        }
        return completed;
    }
    /**
     * 检查单个槽位状态
     */
    async _checkSlotStatus(slot) {
        const elapsed = (Date.now() - slot.startTime) / 1000;
        const timeoutSec = config.GEN_TIMEOUT / 1000;
        // 检查是否已经通过监听器处理完成
        if (slot._videoUrlProcessed && slot._generateProcessed) {
            logger_1.logger.info(`✅ [${slot.taskId}] 监听器已处理完成，释放槽位 (耗时 ${elapsed.toFixed(0)}s)`);
            return {
                task_id: slot.taskId,
                task_info: slot.taskInfo,
                video_path: null, // generate响应不包含视频URL
                status: 'generate_processed',
                externalTaskId: slot.externalTaskId || undefined,
                antiCollisionTag: slot.tag || undefined
            };
        }
        if (slot._videoUrlProcessed && !slot._generateProcessed) {
            logger_1.logger.info(`✅ [${slot.taskId}] asset_list已处理完成，释放槽位 (耗时 ${elapsed.toFixed(0)}s)`);
            return {
                task_id: slot.taskId,
                task_info: slot.taskInfo,
                video_path: null, // 由asset_list监听器直接处理
                status: 'completed',
                externalTaskId: slot.externalTaskId || undefined,
                antiCollisionTag: slot.tag || undefined
            };
        }
        // 检查超时
        if (elapsed > timeoutSec) {
            logger_1.logger.warn(`⏱️ [${slot.taskId}] 生成超时 (${elapsed.toFixed(0)}s)，尝试刷新后关闭页面`);
            try {
                await slot.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
                await this._humanWait(1, 2);
            }
            catch (e) {
                logger_1.logger.warn(`   ⚠️ [${slot.taskId}] 超时刷新失败: ${e}，继续关闭页面`);
            }
            return {
                task_id: slot.taskId,
                task_info: slot.taskInfo,
                video_path: null,
                status: 'timeout_closed',
                externalTaskId: slot.externalTaskId || undefined,
                antiCollisionTag: slot.tag || undefined,
                closeOnly: true
            };
        }
        try {
            const page = slot.page;
            // 检测是否正在生成
            let hasProgress = false;
            try {
                const progressLoc = page.locator('text=/\\d+%/');
                if (await progressLoc.count() > 0 && await progressLoc.first().isVisible({ timeout: 500 })) {
                    hasProgress = true;
                }
            }
            catch { }
            if (!hasProgress) {
                try {
                    const dreamLoc = page.locator('text=造梦中');
                    if (await dreamLoc.count() > 0 && await dreamLoc.first().isVisible({ timeout: 500 })) {
                        hasProgress = true;
                    }
                }
                catch { }
            }
            if (hasProgress && !slot.generationConfirmed) {
                slot.generationConfirmed = true;
                logger_1.logger.info(`   ✅ [${slot.taskId.substring(0, 8)}] 检测到生成进度，确认生成已开始`);
            }
            // 调试日志
            if (!slot._lastDebug || (Date.now() - slot._lastDebug > 30000)) {
                slot._lastDebug = Date.now();
                logger_1.logger.info(`   🔍 [${slot.taskId.substring(0, 8)}] 检测中 (进度=${hasProgress}, 已确认生成=${slot.generationConfirmed}, 耗时=${elapsed.toFixed(0)}s)`);
            }
            const now = Date.now();
            // 动态超时策略：根据槽位压力调整，但要给generate请求足够时间
            const dynamicTimeout = this.getDynamicTimeout();
            // 更保守的释放策略：确保给generate请求至少60秒时间
            if (elapsed > 60 // 最少等待60秒
                && now - slot.lastNetworkAt > dynamicTimeout
                && now - slot.lastRefreshAt > this._slotRefreshIntervalMs) {
                try {
                    const pressure = this.isUnderHighPressure() ? '高压力' : '正常';
                    logger_1.logger.warn(`⚠️ [${slot.taskId.substring(0, 8)}] 任务页长时间无网络事件(${Math.floor((now - slot.lastNetworkAt) / 1000)}s)，${pressure}模式，考虑释放槽位`);
                    // 先尝试刷新
                    await slot.page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
                    await this._humanWait(0.5, 1);
                    slot.lastRefreshAt = now;
                    slot.lastNetworkAt = now;
                    // 高压力时更容易释放槽位，但仍需基本等待时间
                    const releaseThreshold = this.isUnderHighPressure() ? 120 : 180; // 进一步提高释放阈值
                    if (elapsed > releaseThreshold && now - slot.lastNetworkAt > dynamicTimeout) {
                        logger_1.logger.warn(`🗑️ [${slot.taskId.substring(0, 8)}] 刷新后仍无响应，强制释放槽位 (总耗时: ${Math.floor(elapsed / 1000)}s, 阈值: ${releaseThreshold}s)`);
                        return {
                            task_id: slot.taskId,
                            task_info: slot.taskInfo,
                            video_path: null,
                            status: 'idle_timeout',
                            error_msg: `任务空闲超时释放 (${Math.floor(elapsed / 1000)}s, ${pressure}模式)`,
                            externalTaskId: slot.externalTaskId || undefined,
                            antiCollisionTag: slot.tag || undefined,
                            closeOnly: true // 仅关闭，不回传失败
                        };
                    }
                }
                catch (e) {
                    logger_1.logger.warn(`⚠️ [${slot.taskId.substring(0, 8)}] 任务页刷新失败，直接释放: ${e}`);
                    slot.lastRefreshAt = now;
                    // 刷新失败直接释放
                    return {
                        task_id: slot.taskId,
                        task_info: slot.taskInfo,
                        video_path: null,
                        status: 'refresh_failed',
                        error_msg: `页面刷新失败释放 (${Math.floor(elapsed / 1000)}s)`,
                        externalTaskId: slot.externalTaskId || undefined,
                        antiCollisionTag: slot.tag || undefined,
                        closeOnly: true
                    };
                }
            }
            // external_task_id 兜底：当 tag 难以匹配时，允许通过资产状态直接完成
            const externalFallback = this._resolveByExternalTaskIdFallback(slot);
            if (externalFallback) {
                return externalFallback;
            }
            // tag 区间检测
            if (slot.tag && elapsed > 20) {
                const originalPage = this.page;
                this.page = slot.page;
                try {
                    const expectedDur = slot.taskInfo.duration || 5;
                    const videoPath = await this._downloadVideoByTagMenu(slot.page, slot.tag, slot.taskId, expectedDur);
                    if (videoPath && videoPath.startsWith('__GENERATION_FAILED__')) {
                        const errorMsg = videoPath.includes(':') ? videoPath.split(':')[1] : '生成失败';
                        logger_1.logger.warn(`⚠️ [${slot.taskId}] tag区间检测到失败提示: ${errorMsg}，按策略仅关闭tab不回传失败`);
                        return {
                            task_id: slot.taskId,
                            task_info: slot.taskInfo,
                            video_path: null,
                            status: 'tag_failed_closed',
                            error_msg: errorMsg,
                            externalTaskId: slot.externalTaskId || undefined,
                            antiCollisionTag: slot.tag || undefined,
                            closeOnly: true
                        };
                    }
                    if (videoPath) {
                        logger_1.logger.info(`✅ [${slot.taskId}] 生成完成，准备刷新页面获取视频URL (耗时 ${elapsed.toFixed(0)}s)`);
                        // 任务完成，等待历史记录请求并刷新页面
                        await this._waitForHistoryRequestAndRefresh(slot);
                        // 检查视频URL是否已处理完成
                        if (slot._videoUrlProcessed) {
                            logger_1.logger.info(`✅ [${slot.taskId}] 视频URL已处理完成，任务结束`);
                            return {
                                task_id: slot.taskId,
                                task_info: slot.taskInfo,
                                video_path: videoPath, // 这里应该是视频URL
                                status: 'completed',
                                externalTaskId: slot.externalTaskId || undefined,
                                antiCollisionTag: slot.tag || undefined
                            };
                        }
                        else {
                            // 视频URL尚未处理，继续等待
                            logger_1.logger.info(`⏳ [${slot.taskId}] 等待视频URL处理完成...`);
                            return null;
                        }
                    }
                    if (elapsed > timeoutSec * 0.9) {
                        logger_1.logger.warn(`⚠️ [${slot.taskId}] 接近超时且tag区间无有效视频，按策略仅关闭tab不回传失败`);
                        return {
                            task_id: slot.taskId,
                            task_info: slot.taskInfo,
                            video_path: null,
                            status: 'tag_timeout_closed',
                            externalTaskId: slot.externalTaskId || undefined,
                            antiCollisionTag: slot.tag || undefined,
                            closeOnly: true
                        };
                    }
                }
                finally {
                    this.page = originalPage;
                }
            }
        }
        catch (e) {
            logger_1.logger.debug(`   [${slot.taskId}] 完成检测异常: ${e}`);
        }
        return null;
    }
    /**
     * external_task_id 兜底判定
     * - 命中 success：直接完成
     * - 命中 failed：按策略仅关闭 tab，不回传失败
     */
    _resolveByExternalTaskIdFallback(slot) {
        const externalTaskId = slot.externalTaskId || '';
        if (!externalTaskId) {
            return null;
        }
        const state = this._getAssetTaskState(externalTaskId);
        if (!state) {
            return null;
        }
        // 忽略早于任务启动时间太久的旧状态，避免极端串扰
        if (state.updatedAt < slot.startTime - 10000) {
            return null;
        }
        if (state.status === 'success' && state.videoUrl) {
            logger_1.logger.info(`✅ [${slot.taskId}] external_task_id 兜底命中成功: ${externalTaskId}`);
            slot._videoUrlReceived = true;
            slot._videoUrlProcessed = true;
            return {
                task_id: slot.taskId,
                task_info: slot.taskInfo,
                video_path: state.videoUrl,
                status: 'completed',
                externalTaskId,
                antiCollisionTag: slot.tag || undefined
            };
        }
        if (state.status === 'failed') {
            logger_1.logger.warn(`⚠️ [${slot.taskId}] external_task_id 命中失败状态(${externalTaskId})，按策略仅关闭tab不回传失败`);
            return {
                task_id: slot.taskId,
                task_info: slot.taskInfo,
                video_path: null,
                status: 'external_failed_closed',
                error_msg: state.errorMsg,
                externalTaskId,
                antiCollisionTag: slot.tag || undefined,
                closeOnly: true
            };
        }
        return null;
    }
    /**
     * 严格 tag ID 验证下载
     */
    async _downloadVideoByTagMenu(page, tag, taskId, expectedDuration = 5) {
        fs.mkdirSync(config.DOWNLOAD_DIR, { recursive: true });
        try {
            const result = await page.evaluate((tag) => {
                const TAG_MARKER = '⟨⟩⟨';
                // TreeWalker 扫描
                const allNodes = [];
                const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_ALL);
                while (tw.nextNode()) {
                    allNodes.push(tw.currentNode);
                    if (allNodes.length > 200000)
                        break;
                }
                const ourTagPositions = [];
                const markerPositions = [];
                const allVideoNodes = [];
                for (let i = 0; i < allNodes.length; i++) {
                    const n = allNodes[i];
                    if (n.nodeType === 3) {
                        const text = n.textContent || '';
                        if (text.includes(tag))
                            ourTagPositions.push(i);
                        if (text.includes(TAG_MARKER))
                            markerPositions.push(i);
                    }
                    if (n.nodeType === 1 && n.tagName === 'VIDEO') {
                        let src = n.src || '';
                        if (!src) {
                            const source = n.querySelector('source');
                            if (source)
                                src = source.src || '';
                        }
                        if (src && !src.startsWith('blob:') &&
                            !src.includes('loading') && !src.includes('animation') &&
                            !src.includes('static/media')) {
                            allVideoNodes.push({ index: i, src });
                        }
                    }
                }
                if (ourTagPositions.length === 0) {
                    const inBodyText = document.body.textContent?.includes(tag) || false;
                    return {
                        found: false, status: 'tag_not_found',
                        inBodyText, markers: markerPositions.length,
                        videos: allVideoNodes.length, nodes: allNodes.length
                    };
                }
                if (allVideoNodes.length === 0) {
                    return {
                        found: false, status: 'no_video_on_page',
                        tagPositions: ourTagPositions.join(','),
                        markers: markerPositions.length, nodes: allNodes.length
                    };
                }
                // 对每个 tag 出现位置，向前扫描找 video
                for (const tp of ourTagPositions) {
                    let fwdBound = allNodes.length;
                    for (let i = tp + 1; i < allNodes.length; i++) {
                        const n = allNodes[i];
                        if (n.nodeType === 3 && (n.textContent || '').includes(TAG_MARKER)
                            && !(n.textContent || '').includes(tag)) {
                            const isOurMarker = ourTagPositions.some(otp => Math.abs(i - otp) < 30);
                            if (!isOurMarker) {
                                fwdBound = i;
                                break;
                            }
                        }
                    }
                    let foundVideo = null;
                    for (const v of allVideoNodes) {
                        if (v.index > tp && v.index < fwdBound) {
                            foundVideo = v;
                            break;
                        }
                    }
                    if (foundVideo) {
                        return {
                            found: true, status: 'ready',
                            url: foundVideo.src,
                            tagIndex: tp, videoIndex: foundVideo.index,
                            fwdBound,
                            dist: foundVideo.index - tp,
                            tagPositions: ourTagPositions.length,
                            markers: markerPositions.length,
                            totalVideos: allVideoNodes.length
                        };
                    }
                    // 检查失败文本
                    const FAIL_TEXTS = ['未通过审核', '再次生成', '生成失败', '任务失败'];
                    for (let i = tp; i < fwdBound; i++) {
                        const n = allNodes[i];
                        if (n.nodeType === 3) {
                            const t = n.textContent || '';
                            for (const ft of FAIL_TEXTS) {
                                if (t.includes(ft)) {
                                    return {
                                        found: false, status: 'generation_failed',
                                        failText: ft, tagIndex: tp, fwdBound,
                                        tagPositions: ourTagPositions.length,
                                        markers: markerPositions.length
                                    };
                                }
                            }
                        }
                    }
                }
                return {
                    found: false, status: 'no_video_in_card',
                    tagPositions: ourTagPositions.join(','),
                    markers: markerPositions.length,
                    totalVideos: allVideoNodes.length,
                    nodes: allNodes.length
                };
            }, tag);
            if (result && result.found) {
                let url = result.url;
                logger_1.logger.info(`   🎯 [${taskId.substring(0, 8)}] tag卡片video匹配! ` +
                    `(tag@${result.tagIndex} video@${result.videoIndex} ` +
                    `距离=${result.dist}节点) URL: ${url.substring(0, 80)}...`);
                if (url.startsWith('//')) {
                    url = 'https:' + url;
                }
                logger_1.logger.info(`   ✅ [${taskId.substring(0, 8)}] 获取视频URL成功: ${url.substring(0, 80)}...`);
                return url;
            }
            else {
                const status = result?.status || '?';
                if (status === 'tag_not_found') {
                    logger_1.logger.warn(`   ❌ [${taskId.substring(0, 8)}] tag'${tag}'未在文本节点中找到`);
                }
                else if (status === 'no_video_on_page') {
                    logger_1.logger.info(`   🔍 [${taskId.substring(0, 8)}] 页面无video元素`);
                }
                else if (status === 'generation_failed') {
                    const failTxt = result.failText || '生成失败';
                    logger_1.logger.error(`   ❌ [${taskId.substring(0, 8)}] tag区间内检测到生成失败: '${failTxt}'`);
                    return `__GENERATION_FAILED__:${failTxt}`;
                }
                else if (status === 'no_video_in_card') {
                    logger_1.logger.info(`   🔍 [${taskId.substring(0, 8)}] tag区间内无video`);
                }
                else {
                    logger_1.logger.warn(`   [${taskId.substring(0, 8)}] tag检测未知状态: ${JSON.stringify(result)}`);
                }
            }
        }
        catch (e) {
            logger_1.logger.warn(`   [${taskId.substring(0, 8)}] tag检测异常: ${e}`);
        }
        return null;
    }
    /**
     * 获取状态摘要
     */
    getStatusSummary() {
        const active = this.activeSlots.length;
        const taskIds = this.activeSlots.map(s => s.taskId.substring(0, 8));
        return `[${active}/${this._maxSlots}] 活跃: ${taskIds.length > 0 ? taskIds.join(', ') : '无'}`;
    }
    /**
     * 刷新页面以触发资产列表API请求获取视频URL
     */
    async _refreshPageForVideoUrl(slot) {
        try {
            logger_1.logger.info(`🔄 [${slot.taskId}] 刷新页面以获取视频URL...`);
            // 设置标志，表示正在等待视频URL
            slot._waitingForVideoUrl = true;
            slot._videoUrlReceived = false;
            slot._videoUrlProcessed = false;
            // 刷新页面，这会触发资产列表API请求
            await slot.page.reload({ waitUntil: 'domcontentloaded' });
            // 等待页面加载完成
            await sleep(3000);
            logger_1.logger.info(`✅ [${slot.taskId}] 页面刷新完成，等待API响应...`);
            // 等待最多30秒让API响应被捕获和处理
            const startTime = Date.now();
            while (Date.now() - startTime < 30000) {
                if (slot._videoUrlProcessed) {
                    logger_1.logger.info(`✅ [${slot.taskId}] 视频URL已成功处理`);
                    break;
                }
                await sleep(1000);
            }
            if (!slot._videoUrlProcessed) {
                logger_1.logger.warn(`⚠️ [${slot.taskId}] 等待视频URL处理超时`);
            }
            // 重置标志
            slot._waitingForVideoUrl = false;
        }
        catch (e) {
            logger_1.logger.warn(`⚠️ [${slot.taskId}] 页面刷新异常: ${e}`);
            slot._waitingForVideoUrl = false;
        }
    }
    /**
     * 处理任务完成后的页面清理
     * 刷新页面以触发资产列表API，然后关闭页面
     */
    async _waitForHistoryRequestAndRefresh(slot) {
        try {
            logger_1.logger.info(`🔄 [${slot.taskId}] 处理任务完成，准备刷新页面获取视频URL...`);
            // 刷新页面以触发资产列表API调用
            logger_1.logger.info(`🔄 [${slot.taskId}] 开始刷新页面以触发资产列表API...`);
            try {
                const currentUrl = slot.page.url();
                logger_1.logger.debug(`   📍 [${slot.taskId}] 刷新前页面URL: ${currentUrl}`);
                await slot.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
                const reloadedUrl = slot.page.url();
                logger_1.logger.info(`   ✅ [${slot.taskId}] 页面刷新完成，刷新后URL: ${reloadedUrl}`);
                logger_1.logger.info(`   ⏳ [${slot.taskId}] 等待资产列表API响应...`);
                // 短暂等待确保API响应能够被捕获
                await sleep(2000 + Math.random() * 1000);
                logger_1.logger.info(`   🎯 [${slot.taskId}] 页面刷新完成，任务处理结束`);
            }
            catch (e) {
                logger_1.logger.error(`   ❌ [${slot.taskId}] 页面刷新失败: ${e}`);
                logger_1.logger.warn(`   ⚠️ [${slot.taskId}] 刷新失败，但仍继续处理`);
                // 即使刷新失败，也短暂等待尝试捕获可能的API响应
                await sleep(1000 + Math.random() * 1000);
            }
            // 设置标志，表示正在处理视频URL
            slot._waitingForVideoUrl = true;
            slot._videoUrlReceived = false;
            slot._videoUrlProcessed = false;
            // 直接等待视频URL处理完成（不等待 get_history_by_ids 请求）
            logger_1.logger.info(`✅ [${slot.taskId}] 等待视频URL处理完成...`);
            // 等待最多30秒让视频URL被处理
            const startTime = Date.now();
            while (Date.now() - startTime < 30000) {
                if (slot._videoUrlProcessed) {
                    logger_1.logger.info(`✅ [${slot.taskId}] 视频URL已成功处理`);
                    break;
                }
                await sleep(1000);
            }
            if (!slot._videoUrlProcessed) {
                logger_1.logger.warn(`⚠️ [${slot.taskId}] 等待视频URL处理超时，但仍继续关闭页面`);
            }
            // 重置标志
            slot._waitingForVideoUrl = false;
            // 关闭页面/标签页
            try {
                await slot.page.close();
                logger_1.logger.info(`🔒 [${slot.taskId}] 页面已关闭`);
                // 从活跃槽位中移除此槽位
                const index = this.activeSlots.indexOf(slot);
                if (index > -1) {
                    this.activeSlots.splice(index, 1);
                    logger_1.logger.info(`🗑️ [${slot.taskId}] 槽位已从活跃列表中移除`);
                }
            }
            catch (e) {
                logger_1.logger.warn(`⚠️ [${slot.taskId}] 关闭页面异常: ${e}`);
            }
        }
        catch (e) {
            logger_1.logger.warn(`⚠️ [${slot.taskId}] 页面处理异常: ${e}`);
            slot._waitingForVideoUrl = false;
        }
    }
    /**
     * 根据防串台标签找到对应的任务槽位
     * @param tag 防串台标签内容（8位字符）
     * @returns 找到的槽位或null
     */
    findSlotByTag(tag) {
        return this._findSlotByTag(tag);
    }
    async stop() {
        if (this._mainRefreshTimer) {
            clearInterval(this._mainRefreshTimer);
            this._mainRefreshTimer = null;
        }
        if (this._assetProbeTimer) {
            clearInterval(this._assetProbeTimer);
            this._assetProbeTimer = null;
        }
        await super.stop();
    }
    /**
     * 定时资产列表探测：新开页面，上翻 10 页触发 asset_list 请求
     */
    async _runAssetListProbe() {
        if (this._isAssetProbing) {
            return;
        }
        this._isAssetProbing = true;
        let probePage = null;
        try {
            logger_1.logger.info('🧭 资产列表探测开始：新开页面，上翻 20 次，再下翻 20 次');
            probePage = await this.context.newPage();
            await this._injectOptimizer(probePage);
            // 为探测页面设置监听器，确保能捕获到asset_list API响应
            this._setupCreditListener(probePage);
            this._setupWorkspaceListener(probePage);
            this._setupGenerateListener(probePage);
            this._setupAssetListListener(probePage);
            await probePage.goto(config.JIMENG_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await this._humanWait(2, 3);
            const scrollInfo = await probePage.evaluate(() => {
                const candidates = Array.from(document.querySelectorAll('body, html, *'));
                let best = null;
                let bestScore = 0;
                for (const el of candidates) {
                    const style = window.getComputedStyle(el);
                    const overflowY = style.overflowY;
                    if (overflowY !== 'auto' && overflowY !== 'scroll')
                        continue;
                    const scrollHeight = el.scrollHeight || 0;
                    const clientHeight = el.clientHeight || 0;
                    const score = scrollHeight - clientHeight;
                    if (score > bestScore && score > 200) {
                        bestScore = score;
                        best = el;
                    }
                }
                const tag = best ? best.tagName : null;
                return {
                    hasWindowScroll: document.documentElement.scrollHeight > document.documentElement.clientHeight + 50,
                    bestTag: tag,
                    bestScroll: bestScore
                };
            });
            logger_1.logger.info(`🧭 资产列表探测滚动目标: window=${scrollInfo.hasWindowScroll}, bestTag=${scrollInfo.bestTag}, bestScroll=${scrollInfo.bestScroll}`);
            for (let i = 0; i < 200; i++) {
                await probePage.evaluate(() => {
                    const hasWindowScroll = document.documentElement.scrollHeight > document.documentElement.clientHeight + 50;
                    if (hasWindowScroll) {
                        window.scrollBy(0, -window.innerHeight);
                        return;
                    }
                    const candidates = Array.from(document.querySelectorAll('*'));
                    let best = null;
                    let bestScore = 0;
                    for (const el of candidates) {
                        const style = window.getComputedStyle(el);
                        const overflowY = style.overflowY;
                        if (overflowY !== 'auto' && overflowY !== 'scroll')
                            continue;
                        const scrollHeight = el.scrollHeight || 0;
                        const clientHeight = el.clientHeight || 0;
                        const score = scrollHeight - clientHeight;
                        if (score > bestScore && score > 200) {
                            bestScore = score;
                            best = el;
                        }
                    }
                    if (best) {
                        best.scrollBy(0, -window.innerHeight);
                    }
                });
                await this._humanWait(0.2, 0.5);
            }
            for (let i = 0; i < 200; i++) {
                await probePage.evaluate(() => {
                    const hasWindowScroll = document.documentElement.scrollHeight > document.documentElement.clientHeight + 50;
                    if (hasWindowScroll) {
                        window.scrollBy(0, window.innerHeight);
                        return;
                    }
                    const candidates = Array.from(document.querySelectorAll('*'));
                    let best = null;
                    let bestScore = 0;
                    for (const el of candidates) {
                        const style = window.getComputedStyle(el);
                        const overflowY = style.overflowY;
                        if (overflowY !== 'auto' && overflowY !== 'scroll')
                            continue;
                        const scrollHeight = el.scrollHeight || 0;
                        const clientHeight = el.clientHeight || 0;
                        const score = scrollHeight - clientHeight;
                        if (score > bestScore && score > 200) {
                            bestScore = score;
                            best = el;
                        }
                    }
                    if (best) {
                        best.scrollBy(0, window.innerHeight);
                    }
                });
                await this._humanWait(0.2, 0.5);
            }
            await this._humanWait(1, 2);
            logger_1.logger.info('🧭 资产列表探测结束');
        }
        catch (e) {
            logger_1.logger.warn(`⚠️ 资产列表探测失败: ${e}`);
        }
        finally {
            if (probePage) {
                try {
                    await probePage.close();
                }
                catch { }
            }
            this._isAssetProbing = false;
        }
    }
}
exports.ConcurrentBrowserEngine = ConcurrentBrowserEngine;
// 测试代码
if (require.main === module) {
    (async () => {
        const testFile = path.join(__dirname, '..', '..', 'test.txt');
        if (!fs.existsSync(testFile)) {
            console.log(`❌ 找不到测试文件: ${testFile}`);
            process.exit(1);
        }
        const prompts = fs.readFileSync(testFile, 'utf-8').split('\n').filter(l => l.trim());
        console.log(`📋读取到 ${prompts.length} 个测试 Prompt`);
        const engine = new ConcurrentBrowserEngine();
        try {
            await engine.start();
            await engine.login();
            console.log('\n✅ 浏览器已启动并登录成功！开始提交任务...');
            for (let i = 0; i < prompts.length; i++) {
                const prompt = prompts[i];
                const taskInfo = {
                    id: `test_task_${i + 1}`,
                    model_type: 'seedance2.0fast',
                    prompt,
                    duration: 10,
                    ratio: '21:9',
                };
                let submitted = false;
                while (!submitted) {
                    if (engine.hasFreeSlot()) {
                        const success = await engine.submitTask(taskInfo);
                        if (success) {
                            console.log(`🚀 [任务 ${i + 1}] 已提交: ${prompt.substring(0, 30)}...`);
                            submitted = true;
                        }
                        else {
                            console.log(`❌ [任务 ${i + 1}] 提交失败，重试...`);
                            await sleep(2000);
                        }
                    }
                    else {
                        const completed = await engine.pollActiveSlots();
                        for (const c of completed) {
                            console.log(`✅ [任务完成] ${c.task_id} -> ${c.video_path}`);
                        }
                        await sleep(1000);
                    }
                }
            }
            console.log('\n⏳ 所有任务已提交，等待剩余任务完成...');
            while (engine.activeCount() > 0) {
                const completed = await engine.pollActiveSlots();
                for (const c of completed) {
                    console.log(`✅ [任务完成] ${c.task_id} -> ${c.video_path}`);
                }
                console.log(`   剩余活跃任务: ${engine.activeCount()} (每5s刷新)`);
                await sleep(5000);
            }
            console.log('\n🎉 所有测试任务已完成！');
        }
        catch (e) {
            console.error(`\n❌ 测试异常: ${e}`);
        }
        finally {
            await engine.stop();
        }
    })();
}
