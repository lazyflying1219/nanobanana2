function escapeHtml(text) { return text.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m])); }

    // 保存原生 fetch，绕过扩展拦截（修复 ERR_SSL_PROTOCOL_ERROR）
    const nativeFetch = window.fetch.bind(window);

    // Cloudflare 资源代理（部署到 Cloudflare Pages 后可用）：/proxy?url=...
    const ProxyManager = {
        enabled: false,
        init() {
            try {
                const saved = localStorage.getItem('cf_proxy_enabled');
                if (saved === 'true' || saved === 'false') {
                    this.enabled = saved === 'true';
                    return;
                }

                const host = (typeof location !== 'undefined' ? location.hostname : '').toLowerCase();
                const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
                this.enabled = !isLocal && typeof location !== 'undefined' && (location.protocol === 'https:' || location.protocol === 'http:');
            } catch (_) {
                this.enabled = false;
            }
        },
        setEnabled(next) {
            this.enabled = !!next;
            try { localStorage.setItem('cf_proxy_enabled', this.enabled ? 'true' : 'false'); } catch (_) {}
        },
        isEnabled() { return !!this.enabled; },
        shouldProxy(url) {
            if (!this.enabled) return false;
            const raw = String(url || '').trim();
            if (!raw) return false;
            if (raw.startsWith('/proxy?') || raw.startsWith('./proxy?') || raw.startsWith('proxy?')) return false;
            if (raw.startsWith('data:') || raw.startsWith('blob:')) return false;

            try {
                const u = new URL(raw, location.href);
                if (u.origin === location.origin) return false;
                if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
                return true;
            } catch (_) {
                return false;
            }
        },
        getProxiedUrl(url) {
            if (!this.shouldProxy(url)) return url;
            const u = new URL(String(url), location.href);
            return `/proxy?url=${encodeURIComponent(u.href)}`;
        },
        async fetch(url, options) {
            const finalUrl = this.getProxiedUrl(url);
            if (finalUrl === url) return nativeFetch(url, options);

            try {
                const res = await nativeFetch(finalUrl, options);

                // 本地/未部署 Functions 时：/proxy 可能不存在，直接回退直连
                if (res.status === 404 || res.status === 405) {
                    return nativeFetch(url, options);
                }

                // 代理失败时再尝试直连（有些场景直连可用，但代理被限制/上游异常）
                if (!res.ok) {
                    try {
                        return await nativeFetch(url, options);
                    } catch (_) {
                        return res;
                    }
                }

                return res;
            } catch (_) {
                return nativeFetch(url, options);
            }
        }
    };
    ProxyManager.init();

    // 文件系统管理器 - 自动保存图片到本地目录
    const FileSystemManager = {
        directoryHandle: null,
        isEnabled: false,

        // 检查浏览器是否支持 File System Access API
        isSupported() {
            return 'showDirectoryPicker' in window;
        },

        // 初始化
        init() {
            const autoSaveToggle = document.getElementById('auto-save-toggle');
            if (autoSaveToggle) {
                // 加载保存的设置
                const saved = localStorage.getItem('auto_save_enabled');
                if (saved === 'true') {
                    // 检查目录句柄是否存在（刷新页面后会丢失）
                    if (!this.directoryHandle) {
                        // 目录句柄丢失，重置状态并提示用户
                        console.warn('⚠️ 目录句柄丢失，需要重新选择目录');
                        localStorage.removeItem('auto_save_enabled');
                        autoSaveToggle.checked = false;
                        this.isEnabled = false;

                        // 隐藏目录路径显示
                        const pathDiv = document.getElementById('selected-dir-path');
                        if (pathDiv) pathDiv.style.display = 'none';

                        // 延迟显示提示，避免页面加载时过多提示
                        setTimeout(() => {
                            showToast('自动保存已重置，请重新选择保存目录', 'warning', 3000);
                        }, 1000);
                    } else {
                        autoSaveToggle.checked = true;
                        this.isEnabled = true;
                    }
                }

                // 监听开关变化
                autoSaveToggle.addEventListener('change', (e) => {
                    this.isEnabled = e.target.checked;
                    localStorage.setItem('auto_save_enabled', e.target.checked);

                    if (e.target.checked && !this.directoryHandle) {
                        showToast('请先选择保存目录', 'warning');
                        e.target.checked = false;
                        this.isEnabled = false;
                        localStorage.removeItem('auto_save_enabled');
                    }
                });
            }
        },

        // 选择目录
        async selectDirectory() {
            if (!this.isSupported()) {
                showToast('您的浏览器不支持此功能，请使用 Chrome 86+ 或 Edge 86+', 'error', 3000);
                return;
            }

            try {
                // 请求用户选择目录
                this.directoryHandle = await window.showDirectoryPicker({
                    mode: 'readwrite'
                });

                // 显示选择的目录路径
                const pathDiv = document.getElementById('selected-dir-path');
                const pathText = document.getElementById('dir-path-text');
                if (pathDiv && pathText) {
                    pathText.textContent = this.directoryHandle.name;
                    pathDiv.style.display = 'block';
                }

                showToast('目录选择成功！', 'success');

                // 自动启用自动保存
                const autoSaveToggle = document.getElementById('auto-save-toggle');
                if (autoSaveToggle && !autoSaveToggle.checked) {
                    autoSaveToggle.checked = true;
                    this.isEnabled = true;
                    localStorage.setItem('auto_save_enabled', 'true');
                }
            } catch (error) {
                if (error.name !== 'AbortError') {
                    console.error('选择目录失败:', error);
                    showToast('选择目录失败: ' + error.message, 'error');
                }
            }
        },

        // 保存图片到目录
        async saveImageToDirectory(base64Data, filename) {
            console.log('🔍 saveImageToDirectory 被调用');
            console.log('  - isEnabled:', this.isEnabled);
            console.log('  - directoryHandle:', this.directoryHandle);
            console.log('  - filename:', filename);

            if (!this.isEnabled || !this.directoryHandle) {
                console.log('❌ 保存条件不满足');
                return false;
            }

            try {
                console.log('📥 开始保存文件...');
                // 将 base64 转换为 Blob
                const response = await fetch(base64Data);
                const blob = await response.blob();
                console.log('✅ Blob 创建成功，大小:', blob.size);

                // 创建文件
                const fileHandle = await this.directoryHandle.getFileHandle(filename, { create: true });
                console.log('✅ 文件句柄创建成功');

                const writable = await fileHandle.createWritable();
                await writable.write(blob);
                await writable.close();
                console.log('✅ 文件写入成功！');

                return true;
            } catch (error) {
                console.error('❌ 保存文件失败:', error);
                showToast('保存文件失败: ' + error.message, 'error');
                return false;
            }
        }
    };


    // XHS侧栏切换函数
    function toggleXHSSidebar() {
        const sidebar = document.getElementById('xhs-sidebar');
        const overlay = document.getElementById('xhs-sidebar-overlay');

        if (sidebar && overlay) {
            // 检查是否为小屏幕（移动端）
            const isMobile = window.innerWidth <= 1024;

            // 切换侧栏状态
            sidebar.classList.toggle('collapsed');

            // 只在小屏幕时处理遮罩层
            if (isMobile) {
                // 如果侧栏是展开状态（没有collapsed类），显示遮罩
                // 如果侧栏是收起状态（有collapsed类），隐藏遮罩
                if (sidebar.classList.contains('collapsed')) {
                    overlay.classList.remove('active');
                } else {
                    overlay.classList.add('active');
                }
            } else {
                // 大屏幕时确保遮罩始终隐藏
                overlay.classList.remove('active');
            }
        }
    }

    // ===== 增强的用户反馈系统 =====

    // Toast 提示（增强版）
    function showToast(msg, type = 'default', duration = 2000) {
        const t = document.getElementById('toast');
        t.textContent = msg;
        t.className = 'toast-msg';
        if (type !== 'default') t.classList.add(type);
        t.style.display = 'block';
        setTimeout(() => t.style.display = 'none', duration);
    }

    // 全局加载遮罩
    const LoadingManager = {
        show(text = '加载中...') {
            const loading = document.getElementById('global-loading');
            const loadingText = document.getElementById('global-loading-text');
            if (loadingText) loadingText.textContent = text;
            if (loading) loading.classList.add('active');
        },
        hide() {
            const loading = document.getElementById('global-loading');
            if (loading) loading.classList.remove('active');
        },
        updateText(text) {
            const loadingText = document.getElementById('global-loading-text');
            if (loadingText) loadingText.textContent = text;
        }
    };

    // 进度条管理
    const ProgressBar = {
        show() {
            const container = document.getElementById('progress-bar-container');
            if (container) container.classList.add('active');
        },
        hide() {
            const container = document.getElementById('progress-bar-container');
            const bar = document.getElementById('progress-bar');
            if (container) container.classList.remove('active');
            if (bar) bar.style.width = '0%';
        },
        setProgress(percent) {
            const bar = document.getElementById('progress-bar');
            if (bar) bar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
        }
    };

    // 智能进度条管理器（用于单图生成）
    const SmartProgressBar = {
        timers: new Map(),

        // 根据分辨率估算生成时间（秒）
        estimateTime(resolution, hasRefImages = false) {
            const baseTime = {
                '1024x1024': 20,
                '1K': 20,
                '2048x2048': 45,
                '2K': 45,
                '4096x4096': 90,
                '4K': 90
            };
            let time = baseTime[resolution] || 30;
            // 如果有参考图，增加 30% 时间
            if (hasRefImages) time *= 1.3;
            return time;
        },

        // 缓动函数：开始快，后面慢
        easeOutCubic(t) {
            return 1 - Math.pow(1 - t, 3);
        },

        // 启动进度条
        start(elementId, resolution, hasRefImages = false) {
            this.stop(elementId); // 先清除旧的

            const totalTime = this.estimateTime(resolution, hasRefImages);
            const startTime = Date.now();
            const maxProgress = 95; // 最多到 95%，等待实际完成

            const updateProgress = () => {
                const elapsed = (Date.now() - startTime) / 1000;
                const rawProgress = Math.min(elapsed / totalTime, 1);
                const easedProgress = this.easeOutCubic(rawProgress);
                const percent = Math.floor(easedProgress * maxProgress);

                const barEl = document.getElementById(elementId);
                const textEl = document.getElementById(elementId + '-text');

                if (barEl) {
                    barEl.style.width = percent + '%';
                }
                if (textEl) {
                    textEl.textContent = percent + '%';
                }

                if (percent < maxProgress) {
                    const timer = setTimeout(updateProgress, 100);
                    this.timers.set(elementId, timer);
                }
            };

            updateProgress();
        },

        // 完成进度条（跳到 100%）
        complete(elementId, callback) {
            this.stop(elementId);

            const barEl = document.getElementById(elementId);
            const textEl = document.getElementById(elementId + '-text');

            if (barEl) barEl.style.width = '100%';
            if (textEl) textEl.textContent = '100%';

            // 短暂显示 100% 后执行回调
            if (callback) {
                setTimeout(callback, 300);
            }
        },

        // 停止进度条
        stop(elementId) {
            const timer = this.timers.get(elementId);
            if (timer) {
                clearTimeout(timer);
                this.timers.delete(elementId);
            }
        },

        // 创建进度条 HTML
        createHTML(id) {
            return `
                <div style="margin: 20px 0; padding: 12px 16px; background: #f8f9fa; border-radius: 8px; border: 1px solid #e8eaed;">
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
                        <span style="font-size: 13px; color: #5f6368; font-weight: 500;">🎨 图片生成中</span>
                        <span id="${id}-text" style="font-size: 13px; color: #1967d2; font-weight: 600;">0%</span>
                    </div>
                    <div style="width: 100%; height: 6px; background: #e8eaed; border-radius: 3px; overflow: hidden;">
                        <div id="${id}" style="width: 0%; height: 100%; background: linear-gradient(90deg, #1967d2, #4285f4); border-radius: 3px; transition: width 0.3s ease;"></div>
                    </div>
                    <div style="font-size: 11px; color: #80868b; margin-top: 6px;">根据分辨率预估时间，实际可能有偏差</div>
                </div>
            `;
        }
    };

    // 错误处理工具
    const ErrorHandler = {
        show(title, message, actions = []) {
            showToast(`${title}: ${message}`, 'error', 4000);
            console.error(`[Error] ${title}:`, message);
        },
        handleAPIError(error, context = '操作') {
            let message = '未知错误';
            if (error.message) {
                message = error.message;
            } else if (typeof error === 'string') {
                message = error;
            }

            // 根据错误类型提供友好提示
            if (/Bad control character in string literal in JSON/i.test(message)) {
                this.show(`${context}失败`, '接口返回了非标准 JSON（包含未转义换行/控制字符），请尝试切换渠道/模型或关闭流式输出后重试');
                return;
            }
            if (message.includes('fetch') || message.includes('network')) {
                this.show(`${context}失败`, '网络连接失败，请检查网络后重试');
            } else if (message.includes('401') || message.includes('403')) {
                this.show(`${context}失败`, 'API密钥无效或已过期，请检查配置');
            } else if (message.includes('429')) {
                this.show(`${context}失败`, '请求过于频繁，请稍后再试');
            } else if (message.includes('500') || message.includes('502') || message.includes('503')) {
                this.show(`${context}失败`, '服务器错误，请稍后重试');
            } else {
                this.show(`${context}失败`, message);
            }
        }
    };

    async function loadJSZip() { if (window.JSZip) return; await new Promise((r, j) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'; s.onload = r; s.onerror = j; document.head.appendChild(s); }); }

    const BlobManager = {
        urls: [],
        create(blob) { const url = URL.createObjectURL(blob); this.urls.push(url); return url; },
        cleanup() { this.urls.forEach(url => URL.revokeObjectURL(url)); this.urls = []; }
    };

    // === Banana Prompt Logic ===
       // === Banana Prompt Logic (修复版) ===
    const BananaTool = {
        modal: null, grid: null, loading: null, error: null,
        sourceTabsEl: null, categoryTabsEl: null,
        allData: [], searchTerm: '',
        activeCategoryKey: 'all', showAllCategories: false, categoryStats: [], itemIndex: {},
        activeSourceId: 'banana_online', loadedSourceId: '', cacheBySource: {}, requestSeq: 0,
        init() {
            this.modal = document.getElementById('banana-modal');
            this.grid = document.getElementById('banana-grid');
            this.loading = document.getElementById('banana-loading');
            this.error = document.getElementById('banana-error');
            this.sourceTabsEl = document.getElementById('banana-source-tabs');
            this.categoryTabsEl = document.getElementById('banana-category-tabs');

            const supportedSourceIds = new Set(['banana_online', 'local_prompts_json', 'local_prompts2_md']);
            const savedSourceId = (localStorage.getItem('banana_source_id') || '').trim();
            const preferredSourceId = supportedSourceIds.has(savedSourceId) ? savedSourceId : 'banana_online';

            this.activeSourceId = supportedSourceIds.has(preferredSourceId) ? preferredSourceId : 'banana_online';
            this.updateSourceTabsUI();
            this.renderCategoryTabs();

            if (this.sourceTabsEl && !this.sourceTabsEl.dataset.bound) {
                this.sourceTabsEl.dataset.bound = 'true';
                this.sourceTabsEl.addEventListener('click', (e) => {
                    const tab = e.target.closest('.banana-source-tab');
                    if (!tab || !this.sourceTabsEl.contains(tab)) return;
                    this.changeSource(tab.dataset.sourceId);
                });
            }

            if (this.categoryTabsEl && !this.categoryTabsEl.dataset.bound) {
                this.categoryTabsEl.dataset.bound = 'true';
                this.categoryTabsEl.addEventListener('click', (e) => {
                    const tab = e.target.closest('.banana-tab');
                    if (!tab || !this.categoryTabsEl.contains(tab)) return;
                    const key = (tab.dataset.categoryKey || '').trim();
                    if (!key) return;
                    if (key === '__toggle__') {
                        this.showAllCategories = !this.showAllCategories;
                        this.renderCategoryTabs();
                        return;
                    }
                    this.setCategory(key);
                });
            }

            if (this.grid && !this.grid.dataset.bound) {
                this.grid.dataset.bound = 'true';
                this.grid.addEventListener('click', (e) => {
                    const actionEl = e.target.closest('[data-banana-action]');
                    if (!actionEl || !this.grid.contains(actionEl)) return;
                    const action = (actionEl.dataset.bananaAction || '').trim();
                    if (!action) return;

                    const cardEl = actionEl.closest('.banana-card');
                    if (!cardEl) return;
                    const id = (cardEl.dataset.id || '').trim();
                    const item = id && this.itemIndex ? this.itemIndex[id] : null;
                    if (!item) return;

                    if (action === 'copy') {
                        this.copy(item.prompt);
                        e.preventDefault();
                    } else if (action === 'preview') {
                        const imgEl = actionEl.tagName === 'IMG' ? actionEl : cardEl.querySelector('img.banana-img');
                        const src = imgEl && imgEl.src ? imgEl.src : item.preview;
                        if (src && typeof openLightbox === 'function') {
                            openLightbox(src);
                        } else if (src) {
                            window.open(src, '_blank', 'noopener');
                        } else {
                            showToast('暂无可预览图片', 'warning');
                        }
                        e.preventDefault();
                    } else if (action === 'fill') {
                        this.sendToInput(item.prompt, false);
                        e.preventDefault();
                    } else if (action === 'save') {
                        this.saveToCustom(item.title, item.prompt);
                        e.preventDefault();
                    }
                });
            }
        },
        normalizeCategoryKey(value) {
            return this.normalizeText(value, '').toLowerCase().replace(/\s+/g, ' ').trim();
        },
        getCategoryLabel(key) {
            const k = this.normalizeCategoryKey(key);
            if (k === 'all') return '全部';
            if (k === 'generate') return '生成';
            if (k === 'edit') return '编辑';
            const stat = Array.isArray(this.categoryStats) ? this.categoryStats.find(s => s && s.key === k) : null;
            return stat && stat.label ? stat.label : (key || '');
        },
        updateSourceTabsUI() {
            if (!this.sourceTabsEl) return;
            const active = (this.activeSourceId || '').trim();
            this.sourceTabsEl.querySelectorAll('.banana-source-tab').forEach(tab => {
                const id = (tab.dataset.sourceId || '').trim();
                tab.classList.toggle('active', id === active);
            });
        },
        setCategory(key) {
            const normalized = this.normalizeCategoryKey(key || 'all') || 'all';
            this.activeCategoryKey = normalized;
            this.renderCategoryTabs();
            this.render();
        },
        renderCategoryTabs() {
            if (!this.categoryTabsEl) return;
            const MAX_VISIBLE = 14;
            const stats = Array.isArray(this.categoryStats) ? this.categoryStats : [];
            const active = this.activeCategoryKey || 'all';

            const allTab = { key: 'all', label: '全部', count: Array.isArray(this.allData) ? this.allData.length : 0 };
            const list = stats.filter(s => s && s.key && !['all', 'generate', 'edit'].includes(s.key));
            const shouldToggle = list.length > MAX_VISIBLE;

            let visible = list;
            if (shouldToggle && !this.showAllCategories) {
                visible = list.slice(0, MAX_VISIBLE);
                if (active !== 'all' && !visible.some(s => s.key === active)) {
                    const activeStat = list.find(s => s.key === active);
                    if (activeStat) {
                        visible = visible.slice(0, Math.max(0, MAX_VISIBLE - 1)).concat([activeStat]);
                    }
                }
            }

            this.categoryTabsEl.innerHTML = '';
            const frag = document.createDocumentFragment();

            const makeTab = (key, label, isActive) => {
                const el = document.createElement('div');
                el.className = 'banana-tab' + (isActive ? ' active' : '');
                el.dataset.categoryKey = key;
                el.textContent = label;
                return el;
            };

            frag.appendChild(makeTab(allTab.key, allTab.label, active === 'all'));
            frag.appendChild(makeTab('generate', 'GENERATE', active === 'generate'));
            frag.appendChild(makeTab('edit', 'EDIT', active === 'edit'));

            visible.forEach(stat => {
                const label = stat.label || this.getCategoryLabel(stat.key);
                frag.appendChild(makeTab(stat.key, label, stat.key === active));
            });

            if (shouldToggle) {
                frag.appendChild(makeTab('__toggle__', this.showAllCategories ? '收起' : '更多', false));
            }

            this.categoryTabsEl.appendChild(frag);
        },
        prepareItems(data = [], sourceId = '') {
            const rawItems = Array.isArray(data) ? data : [];
            const placeholder = this.getPlaceholderPreview();
            const normalizedSource = this.normalizeText(sourceId, 'banana');
            const usedIds = new Set();

            return rawItems.map((rawItem, idx) => {
                const it = (rawItem && typeof rawItem === 'object') ? rawItem : {};
                let id = this.normalizeText(it.id, `${normalizedSource}_${idx + 1}`);
                if (usedIds.has(id)) id = `${id}_${idx + 1}`;
                usedIds.add(id);

                const title = this.normalizeText(it.title, `未命名-${idx + 1}`);
                const prompt = this.normalizeText(it.prompt, '');
                const category = this.normalizeText(it.category, '其他');
                const subCategory = this.normalizeText(it.sub_category, '');
                const mode = this.normalizeText(it.mode, 'generate');
                const preview = this.normalizeText(it.preview, '') || placeholder;
                const author = this.normalizeText(it.author, '');
                const link = this.normalizeText(it.link, '');

                const tags = Array.isArray(it.tags) ? it.tags
                    .filter(t => typeof t === 'string')
                    .map(t => t.trim())
                    .filter(Boolean)
                    : [];

                const filterCandidates = normalizedSource === 'local_prompts_json'
                    ? [...tags, mode]
                    : [...tags, category, subCategory, mode].filter(Boolean);
                const filterSet = new Set();
                filterCandidates.forEach(label => {
                    const key = this.normalizeCategoryKey(label);
                    if (!key || key === 'all') return;
                    if (key.includes('nsfw')) return;
                    filterSet.add(key);
                });

                const searchText = [title, prompt, category, subCategory, tags.join(' ')]
                    .filter(Boolean)
                    .join('\n')
                    .toLowerCase();

                return {
                    ...it,
                    id,
                    title,
                    prompt,
                    category,
                    sub_category: subCategory,
                    mode,
                    preview,
                    author,
                    link,
                    tags,
                    filterTags: Array.from(filterSet),
                    __searchText: searchText,
                    __bananaPrepared: true
                };
            });
        },
        getOpenNanaCategoryLabel(key, fallbackLabel = '') {
            const k = this.normalizeCategoryKey(key);
            const map = {
                'photography': '摄影',
                'nature': '自然',
                'landscape': '风景',
                'portrait': '人像',
                'vehicle': '交通工具',
                'character': '角色',
                'minimalist': '极简',
                'fashion': '时尚',
                'logo': '标志',
                'paper-craft': '纸艺',
                'typography': '字体排版',
                'illustration': '插画',
                'interior': '室内',
                'branding': '品牌',
                'product': '产品',
                'cartoon': '卡通',
                '3d': '3D',
                'retro': '复古',
                'food': '美食',
                'poster': '海报',
                'architecture': '建筑',
                'neon': '霓虹',
                'toy': '玩具',
                'creative': '创意',
                'futuristic': '未来主义',
                'animal': '动物',
                'ui': '界面/UI',
                'fantasy': '奇幻',
                'pixel': '像素',
                'sculpture': '雕塑',
                'infographic': '信息图',
                'sci-fi': '科幻',
                'felt': '毛毡',
                'gaming': '游戏',
                'clay': '黏土',
                'emoji': '表情符号',
                'data-viz': '数据可视化'
            };
            const cn = map[k];
            if (cn) return `${cn} (${k})`;
            return fallbackLabel || key;
        },
        buildCategoryStats(items = [], sourceId = '') {
            const list = Array.isArray(items) ? items : [];
            const normalizedSource = this.normalizeText(sourceId, '') || this.activeSourceId;
            const modeKeys = new Set();
            list.forEach(item => {
                const k = this.normalizeCategoryKey(item && item.mode ? item.mode : '');
                if (k) modeKeys.add(k);
            });
            const includeMode = modeKeys.size > 1;

            const statsMap = new Map();

            list.forEach(item => {
                const it = (item && typeof item === 'object') ? item : {};
                const perItem = new Set();
                const candidates = [];

                if (Array.isArray(it.tags)) candidates.push(...it.tags);
                if (it.category && normalizedSource !== 'local_prompts_json') candidates.push(it.category);
                if (it.sub_category) candidates.push(it.sub_category);
                if (includeMode && it.mode) candidates.push(it.mode);

                candidates.forEach(label => {
                    const raw = this.normalizeText(label, '');
                    if (!raw) return;
                    const key = this.normalizeCategoryKey(raw);
                    if (!key || key === 'all') return;
                    if (key.includes('nsfw')) return;
                    if (perItem.has(key)) return;
                    perItem.add(key);

                    const labelForUi = key === 'generate'
                        ? '生成'
                        : key === 'edit'
                            ? '编辑'
                            : normalizedSource === 'local_prompts_json'
                                ? this.getOpenNanaCategoryLabel(key, raw)
                                : raw;
                    const existing = statsMap.get(key);
                    if (!existing) {
                        statsMap.set(key, { key, label: labelForUi, count: 1 });
                        return;
                    }
                    existing.count += 1;
                    if (!existing.label && labelForUi) existing.label = labelForUi;
                });
            });

            const stats = Array.from(statsMap.values());
            stats.sort((a, b) => (b.count - a.count) || String(a.label).localeCompare(String(b.label), 'zh-Hans-CN'));
            return stats;
        },
        setData(data, { sourceId } = {}) {
            const normalizedSourceId = this.normalizeText(sourceId, '') || this.activeSourceId;
            const prepared = Array.isArray(data) && data.length > 0 && data[0] && data[0].__bananaPrepared
                ? data
                : this.prepareItems(data, normalizedSourceId);

            this.allData = prepared;
            this.loadedSourceId = normalizedSourceId;

            const index = Object.create(null);
            prepared.forEach(item => {
                if (item && item.id) index[item.id] = item;
            });
            this.itemIndex = index;

            this.categoryStats = this.buildCategoryStats(prepared, normalizedSourceId);
            const fixedKeys = new Set(['all', 'generate', 'edit']);
            if (!fixedKeys.has(this.activeCategoryKey) && !this.categoryStats.some(s => s && s.key === this.activeCategoryKey)) {
                this.activeCategoryKey = 'all';
            }

            this.renderCategoryTabs();
            this.render();
        },
        open() {
            if(!this.modal) this.init();
            closeAllSidebars();
            this.modal.classList.add('active');
            this.updateSourceTabsUI();
            if(this.allData.length === 0 || this.loadedSourceId !== this.activeSourceId) this.fetchData();
        },
        close() { this.modal.classList.remove('active'); },
        changeSource(sourceId) {
            const supportedSourceIds = new Set(['banana_online', 'local_prompts_json', 'local_prompts2_md']);
            const nextSourceId = supportedSourceIds.has((sourceId || '').trim()) ? sourceId.trim() : 'banana_online';

            if (nextSourceId === this.activeSourceId && this.loadedSourceId === nextSourceId) {
                this.updateSourceTabsUI();
                return;
            }

            this.activeSourceId = nextSourceId;
            localStorage.setItem('banana_source_id', nextSourceId);
            this.updateSourceTabsUI();

            this.loadedSourceId = '';
            this.allData = [];
            this.itemIndex = {};
            this.categoryStats = [];
            this.activeCategoryKey = 'all';
            this.showAllCategories = false;
            this.searchTerm = '';
            const input = this.modal ? this.modal.querySelector('.banana-search-input') : null;
            if (input) input.value = '';
            this.renderCategoryTabs();

            this.fetchData();
        },
        async fetchData({ forceReload = false } = {}) {
            const sourceId = (this.activeSourceId || 'banana_online').trim() || 'banana_online';
            this.activeSourceId = sourceId;
            this.updateSourceTabsUI();

            if (forceReload) {
                delete this.cacheBySource[sourceId];
            }

            if (!forceReload && this.cacheBySource[sourceId] && this.cacheBySource[sourceId].length > 0) {
                this.loading.style.display = 'none';
                this.error.style.display = 'none';
                this.setData(this.cacheBySource[sourceId], { sourceId });
                return;
            }

            const requestId = ++this.requestSeq;
            this.loading.style.display = 'block';
            this.error.style.display = 'none';
            this.grid.innerHTML = '';

            try {
                let data = [];
                if (this.activeSourceId === 'banana_online') {
                    data = await this.loadBananaOnline();
                } else if (this.activeSourceId === 'local_prompts_json') {
                    data = await this.loadOpenNanaLocalJson();
                } else if (this.activeSourceId === 'local_prompts2_md') {
                    data = await this.loadYouMindLocalMarkdown();
                } else {
                    throw new Error(`未知提示词源：${this.activeSourceId}`);
                }

                if (requestId !== this.requestSeq) return;

                if (!Array.isArray(data) || data.length === 0) {
                    throw new Error('提示词数据为空或格式不正确');
                }

                const prepared = this.prepareItems(data, sourceId);
                this.cacheBySource[sourceId] = prepared;
                this.loading.style.display = 'none';
                this.error.style.display = 'none';
                this.setData(prepared, { sourceId });
                showToast(`成功加载 ${prepared.length} 个提示词`, 'success');

            } catch (e) {
                if (requestId !== this.requestSeq) return;
                console.error('加载提示词失败:', e);
                this.loading.style.display = 'none';
                this.error.style.display = 'block';
                const friendlyMessage = this.formatLoadError(e);
                this.setErrorText(friendlyMessage);
                ErrorHandler.show('加载提示词失败', friendlyMessage);
            }
        },
        setErrorText(text) {
            if (!this.error) return;
            const nodes = Array.from(this.error.childNodes || []);
            const textNode = nodes.find(n => n && n.nodeType === 3);
            if (textNode) textNode.textContent = text;
        },
        formatLoadError(error) {
            const raw = error && error.message ? String(error.message) : '';
            const sourceId = this.activeSourceId;

            if (sourceId === 'local_prompts_json' || sourceId === 'local_prompts2_md') {
                if (typeof location !== 'undefined' && location.protocol === 'file:') {
                    return '当前通过本地文件方式打开，浏览器限制导致无法加载本地提示词库，请通过本地服务器访问。';
                }
                if (raw.includes('404')) {
                    return '未找到本地提示词数据，请确认已放在同级目录并通过本地服务器访问。';
                }
                if (raw.toLowerCase().includes('json') && (raw.includes('格式') || raw.includes('parse'))) {
                    return '本地提示词数据格式不正确，请检查文件是否完整。';
                }
                if (raw.includes('Failed to fetch') || raw.includes('fetch')) {
                    return '本地提示词数据加载失败，请检查本地服务是否正常。';
                }
                return '本地提示词数据加载失败，请检查文件与本地服务。';
            }

            return raw || '加载失败，请稍后重试';
        },
        getPlaceholderPreview() {
            return 'https://placehold.co/600x400/e2e8f0/94a3b8?text=No+Preview';
        },
        normalizeText(value, fallback = '') {
            if (value === null || value === undefined) return fallback;
            const text = String(value).trim();
            return text.length > 0 ? text : fallback;
        },
        buildAbsoluteUrl(path, baseUrl) {
            const p = this.normalizeText(path, '');
            if (!p) return '';
            if (/^https?:\/\//i.test(p)) return p;
            const base = this.normalizeText(baseUrl, '').replace(/\/+$/, '');
            return `${base}/${p.replace(/^\/+/, '')}`;
        },
        sanitizeAuthor(author) {
            const raw = this.normalizeText(author, '');
            if (!raw) return '';
            return raw.startsWith('@') ? raw.slice(1) : raw;
        },
        async loadBananaOnline() {
            const URLS = [
                'https://raw.githubusercontent.com/glidea/banana-prompt-quicker/refs/heads/main/prompts.json',
                'https://cdn.jsdelivr.net/gh/glidea/banana-prompt-quicker@main/prompts.json',
                'https://fastly.jsdelivr.net/gh/glidea/banana-prompt-quicker@main/prompts.json',
                'http://gh.halonice.com/https://raw.githubusercontent.com/glidea/banana-prompt-quicker/refs/heads/main/prompts.json'
            ];

            let lastError = null;
            for (let i = 0; i < URLS.length; i++) {
                try {
                    const fetcher = (ProxyManager && ProxyManager.isEnabled()) ? ProxyManager : null;
                    const res = fetcher ? await fetcher.fetch(URLS[i], { timeout: 10000 }) : await nativeFetch(URLS[i], { timeout: 10000 });
                    if(!res.ok) throw new Error(`HTTP ${res.status}: 数据加载失败`);
                    const data = await res.json();
                    if (!Array.isArray(data) || data.length === 0) throw new Error('数据格式错误或为空');

                    const safeData = data.filter(item => {
                        const normalized = (item && typeof item === 'object') ? item : {};
                        const category = this.normalizeText(normalized.category, '').toLowerCase();
                        const subCategory = this.normalizeText(normalized.sub_category, '').toLowerCase();
                        return !category.includes('nsfw') && !subCategory.includes('nsfw');
                    });
                    if (safeData.length === 0) throw new Error('数据加载失败（过滤后为空）');

                    return safeData.map((item, idx) => {
                        const normalized = (item && typeof item === 'object') ? item : {};
                        return {
                            id: this.normalizeText(normalized.id, `banana_${idx + 1}`),
                            title: this.normalizeText(normalized.title, `未命名-${idx + 1}`),
                            prompt: this.normalizeText(normalized.prompt, ''),
                            category: this.normalizeText(normalized.category, '其他'),
                            mode: this.normalizeText(normalized.mode, 'generate'),
                            preview: this.normalizeText(normalized.preview, this.getPlaceholderPreview()),
                            author: this.normalizeText(normalized.author, ''),
                            link: this.normalizeText(normalized.link, ''),
                            sub_category: this.normalizeText(normalized.sub_category, ''),
                            created: this.normalizeText(normalized.created, ''),
                        };
                    });

                } catch(e) {
                    console.warn(`源 ${i + 1} 失败:`, URLS[i], e.message);
                    lastError = e;
                    if (i < URLS.length - 1) continue;
                }
            }

            throw lastError || new Error('所有在线源均不可用');
        },
        async loadOpenNanaLocalJson() {
            if (typeof location !== 'undefined' && location.protocol === 'file:') {
                throw new Error('本地文件方式打开会被浏览器限制，请通过本地服务器访问。');
            }
            const res = await nativeFetch('./prompts.json');
            if (!res.ok) throw new Error(`本地提示词数据加载失败 (HTTP ${res.status})`);
            const json = await res.json();
            if (!json || !Array.isArray(json.items)) throw new Error('本地提示词数据格式不正确：需要 { items: [] }');

            const base = 'https://opennana.com/awesome-prompt-gallery/';
            const placeholder = this.getPlaceholderPreview();

            return json.items.map((item, idx) => {
                const it = (item && typeof item === 'object') ? item : {};
                const prompts = Array.isArray(it.prompts) ? it.prompts.filter(Boolean) : [];
                const combinedPrompt = prompts.length > 0 ? prompts.join('\n\n---\n\n') : this.normalizeText(it.prompt, '');
                const previewPath = this.normalizeText(it.coverImage, '') || (Array.isArray(it.images) && it.images.length ? it.images[0] : '');

                return {
                    id: this.normalizeText(it.id, it.slug ? `opennana_${it.slug}` : `opennana_${idx + 1}`),
                    title: this.normalizeText(it.title, this.normalizeText(it.slug, `OpenNana-${idx + 1}`)),
                    prompt: combinedPrompt,
                    category: 'OpenNana',
                    mode: 'generate',
                    preview: this.buildAbsoluteUrl(previewPath, base) || placeholder,
                    author: this.sanitizeAuthor(it.source && it.source.name ? it.source.name : ''),
                    link: this.normalizeText(it.source && it.source.url ? it.source.url : '', ''),
                    tags: Array.isArray(it.tags) ? it.tags : []
                };
            });
        },
        parseYouMindMarkdown(text) {
            const placeholder = this.getPlaceholderPreview();
            const lines = String(text || '').split(/\r?\n/);
            const items = [];
            const seen = new Set();

            const titleReg = /^###\s+No\.\s*(\d+)\s*:\s*(.+?)\s*$/;
            const isBadgeUrl = (url) => {
                const u = this.normalizeText(url, '').toLowerCase();
                return u.includes('img.shields.io/') || u.includes('awesome.re/badge');
            };
            const shouldUsePreview = (candidate, current) => {
                const c = this.normalizeText(candidate, '');
                if (!c) return false;
                const cur = this.normalizeText(current, '');
                if (!cur) return true;
                return isBadgeUrl(cur) && !isBadgeUrl(c);
            };
            let i = 0;

            while (i < lines.length) {
                const header = lines[i].match(titleReg);
                if (!header) { i++; continue; }

                const number = header[1];
                const fullTitle = this.normalizeText(header[2], `YouMind-${number}`);
                let displayTitle = fullTitle;
                let derivedCategory = 'YouMind';
                const derivedTags = new Set();

                const titleMatch = fullTitle.match(/^(.+?)\s*-\s*(.+)$/);
                if (titleMatch) {
                    derivedCategory = this.normalizeText(titleMatch[1], 'YouMind');
                    displayTitle = this.normalizeText(titleMatch[2], fullTitle);
                    derivedCategory
                        .split(/\s*[/\\]\s*/)
                        .map(part => part.trim())
                        .filter(Boolean)
                        .forEach(part => derivedTags.add(part));
                }
                let prompt = '';
                let preview = '';
                let author = '';
                let link = '';
                let lang = '';

                i++;
                while (i < lines.length && !titleReg.test(lines[i])) {
                    const line = lines[i];

                    const imgTag = line.match(/<img[^>]+src=["']([^"']+)["']/i);
                    if (imgTag && shouldUsePreview(imgTag[1], preview)) preview = imgTag[1].trim();

                    const mdImg = line.match(/!\[[^\]]*\]\(([^)]+)\)/);
                    if (mdImg && /^https?:\/\//i.test(mdImg[1]) && !isBadgeUrl(mdImg[1]) && shouldUsePreview(mdImg[1], preview)) {
                        preview = mdImg[1].trim();
                    }

                    const authorMatch = line.match(/-\s+\*\*作者:\*\*\s+\[([^\]]+)\]\(([^)]+)\)/);
                    if (authorMatch) {
                        author = authorMatch[1].trim();
                        if (!link) link = authorMatch[2].trim();
                    }

                    const sourceMatch = line.match(/-\s+\*\*来源:\*\*\s+\[[^\]]+\]\(([^)]+)\)/);
                    if (sourceMatch) link = sourceMatch[1].trim();

                    const langMatch = line.match(/-\s+\*\*多语言:\*\*\s*([^\s]+)/);
                    if (langMatch) lang = langMatch[1].trim();

                    if (!prompt && /####\s+.*提示词/.test(line)) {
                        i++;
                        while (i < lines.length && !/^```/.test(lines[i])) i++;
                        if (i < lines.length && /^```/.test(lines[i])) {
                            i++;
                            const buf = [];
                            while (i < lines.length && !/^```/.test(lines[i])) {
                                buf.push(lines[i]);
                                i++;
                            }
                            prompt = buf.join('\n').trim();
                        }
                    }

                    i++;
                }

                const finalPrompt = this.normalizeText(prompt, '');
                const dedupeKey = `${fullTitle}\n${finalPrompt}`;
                if (!seen.has(dedupeKey)) {
                    seen.add(dedupeKey);
                    items.push({
                        id: `youmind_${number}_${items.length + 1}`,
                        title: displayTitle,
                        prompt: finalPrompt,
                        category: derivedCategory,
                        mode: 'generate',
                        preview: isBadgeUrl(preview) ? placeholder : this.normalizeText(preview, placeholder),
                        author: this.normalizeText(author, 'YouMind'),
                        link: this.normalizeText(link, ''),
                        tags: Array.from(derivedTags)
                    });
                }
            }

            return items;
        },
        async loadYouMindLocalMarkdown() {
            if (typeof location !== 'undefined' && location.protocol === 'file:') {
                throw new Error('本地文件方式打开会被浏览器限制，请通过本地服务器访问。');
            }
            const res = await nativeFetch('./prompts2.md');
            if (!res.ok) throw new Error(`本地提示词数据加载失败 (HTTP ${res.status})`);
            const text = await res.text();
            const items = this.parseYouMindMarkdown(text);
            if (!items.length) throw new Error('未从本地提示词文档解析到提示词，请确认文件内容完整');
            return items;
        },
        filter(type, btnEl) {
            this.currentFilter = type;
            document.querySelectorAll('.banana-tab').forEach(t => t.classList.remove('active'));
            btnEl.classList.add('active');
            this.render();
        },
        handleSearch(val) {
            this.searchTerm = val.toLowerCase().trim();
            this.render();
        },
        renderLegacy() {
            this.grid.innerHTML = '';
            const filtered = this.allData.filter(item => {
                let tabMatch = true;
                if(this.currentFilter === 'all') {
                    tabMatch = true;
                } else if(this.currentFilter === 'generate') {
                    tabMatch = item.mode === 'generate';
                } else if(this.currentFilter === 'edit') {
                    tabMatch = item.mode === 'edit';
                } else if(this.currentFilter === 'study') {
                    tabMatch = (item.category || '').toLowerCase() === '学习';
                } else if(this.currentFilter === 'work') {
                    tabMatch = (item.category || '').toLowerCase() === '工作';
                }
                
                let searchMatch = true;
                if(this.searchTerm) {
                    const s = this.searchTerm;
                    const title = (item.title || '').toLowerCase();
                    const prompt = (item.prompt || '').toLowerCase();
                    const category = (item.category || '').toLowerCase();
                    if(!title.includes(s) && !prompt.includes(s) && !category.includes(s)) searchMatch = false;
                }
                return tabMatch && searchMatch;
            });
            if(filtered.length === 0) {
                this.grid.innerHTML = `<div style="text-align:center; color:#999; grid-column:1/-1; padding:40px;"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin:0 auto 12px; display:block; opacity:0.5;"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>未找到相关提示词</div>`;
                return;
            }
            filtered.forEach(item => {
                const card = document.createElement('div');
                card.className = 'banana-card';
                const modeTagClass = item.mode === 'generate' ? 'mode-generate' : 'mode-edit';
                const safePrompt = encodeURIComponent(item.prompt);
                const safeTitle = encodeURIComponent(item.title);
                card.innerHTML = `<div class="banana-preview-box"><img src="${item.preview}" class="banana-img" loading="lazy" onerror="this.src='https://placehold.co/600x400/e2e8f0/94a3b8?text=No+Preview'"><div class="banana-tags"><span class="banana-tag">${item.category}</span><span class="banana-tag ${modeTagClass}">${item.mode}</span></div></div><div class="banana-content"><div class="banana-title">${item.title}</div><div class="banana-prompt-box" onclick="BananaTool.copy('${safePrompt}')"><div class="banana-prompt-text">${escapeHtml(item.prompt)}</div><div class="banana-prompt-tip"><span>点击复制</span></div></div><div class="banana-footer"><div class="banana-author"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg> ${item.author ? item.author.split('@')[0] : 'Unknown'}</div><div class="banana-actions">${item.link ? `<a href="${item.link}" target="_blank" class="banana-icon-btn" title="查看原链接"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg></a>` : ''}<div class="banana-icon-btn" title="填充到输入框" onclick="BananaTool.sendToInput('${safePrompt}')" style="color:#1a73e8;"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></div><div class="banana-icon-btn" title="保存到我的提示词" onclick="BananaTool.saveToCustom('${safeTitle}','${safePrompt}')" style="color:#ea4335;"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg></div><div class="banana-icon-btn" title="复制提示词" onclick="BananaTool.copy('${safePrompt}')"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></div></div></div></div>`;
                this.grid.appendChild(card);
            });
        },
        render() {
            if (!this.grid) return;
            this.grid.innerHTML = '';

            const items = Array.isArray(this.allData) ? this.allData : [];
            const activeKey = this.activeCategoryKey || 'all';
            const term = (this.searchTerm || '').trim().toLowerCase();

            const filtered = items.filter(item => {
                const it = (item && typeof item === 'object') ? item : {};

                if (activeKey !== 'all') {
                    const tags = Array.isArray(it.filterTags) ? it.filterTags : [];
                    if (!tags.includes(activeKey)) return false;
                }

                if (!term) return true;

                const hay = typeof it.__searchText === 'string' ? it.__searchText : '';
                if (hay && hay.includes(term)) return true;

                const fallback = [
                    this.normalizeText(it.title, ''),
                    this.normalizeText(it.prompt, ''),
                    this.normalizeText(it.category, ''),
                    this.normalizeText(it.sub_category, ''),
                    Array.isArray(it.tags) ? it.tags.join(' ') : ''
                ].join('\n').toLowerCase();
                return fallback.includes(term);
            });

            if (filtered.length === 0) {
                this.grid.innerHTML = `<div style="text-align:center; color:#999; grid-column:1/-1; padding:40px;"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin:0 auto 12px; display:block; opacity:0.5;"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>未找到相关提示词</div>`;
                return;
            }

            const placeholder = this.getPlaceholderPreview();
            const placeholderFinal = ProxyManager ? ProxyManager.getProxiedUrl(placeholder) : placeholder;
            const frag = document.createDocumentFragment();

            filtered.forEach(item => {
                const it = (item && typeof item === 'object') ? item : {};
                const card = document.createElement('div');
                card.className = 'banana-card';
                card.dataset.id = this.normalizeText(it.id, '');

                const modeKey = this.normalizeCategoryKey(it.mode);
                const modeTagClass = modeKey === 'edit' ? 'mode-edit' : 'mode-generate';

                const title = escapeHtml(this.normalizeText(it.title, ''));
                const prompt = escapeHtml(this.normalizeText(it.prompt, ''));
                let categoryLabel = this.normalizeText(it.category, '');
                if (this.activeSourceId === 'local_prompts_json') {
                    const isModeFilter = activeKey === 'generate' || activeKey === 'edit';
                    if (!isModeFilter && activeKey !== 'all') {
                        categoryLabel = this.getOpenNanaCategoryLabel(activeKey, activeKey);
                    } else if (Array.isArray(it.tags) && it.tags.length > 0) {
                        categoryLabel = this.getOpenNanaCategoryLabel(it.tags[0], it.tags[0]);
                    } else {
                        categoryLabel = 'OpenNana';
                    }
                }
                const category = escapeHtml(categoryLabel);
                const mode = escapeHtml(this.normalizeText(it.mode, ''));
                const rawPreview = this.normalizeText(it.preview, '') || placeholder;
                const preview = escapeHtml(ProxyManager ? ProxyManager.getProxiedUrl(rawPreview) : rawPreview);
                const rawPreviewEscaped = escapeHtml(rawPreview);
                const placeholderEscaped = escapeHtml(placeholderFinal);
                const author = escapeHtml(this.normalizeText(it.author, 'Unknown').split('@')[0]);

                const rawLink = this.normalizeText(it.link, '');
                const safeLink = /^https?:\/\//i.test(rawLink) ? escapeHtml(rawLink) : '';
                const linkHtml = safeLink
                    ? `<a href="${safeLink}" target="_blank" rel="noopener noreferrer" class="banana-icon-btn" title="查看原链接"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg></a>`
                    : '';

                card.innerHTML = `
                    <div class="banana-preview-box" data-banana-action="preview" title="点击查看大图">
                        <img src="${preview}" class="banana-img" loading="lazy" data-raw-src="${rawPreviewEscaped}" data-placeholder-src="${placeholderEscaped}" onerror="handlePromptImageError(this)" data-banana-action="preview">
                        <div class="banana-tags">
                            <span class="banana-tag">${category}</span>
                            <span class="banana-tag ${modeTagClass}">${mode}</span>
                        </div>
                    </div>
                    <div class="banana-content">
                        <div class="banana-title">${title}</div>
                        <div class="banana-prompt-box" data-banana-action="copy">
                            <div class="banana-prompt-text">${prompt}</div>
                            <div class="banana-prompt-tip"><span>点击复制</span></div>
                        </div>
                        <div class="banana-footer">
                            <div class="banana-author"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg> ${author}</div>
                            <div class="banana-actions">
                                ${linkHtml}
                                <div class="banana-icon-btn" title="填充到输入框" data-banana-action="fill" style="color:#1a73e8;"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></div>
                                <div class="banana-icon-btn" title="保存到我的提示词" data-banana-action="save" style="color:#ea4335;"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg></div>
                                <div class="banana-icon-btn" title="复制提示词" data-banana-action="copy"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></div>
                            </div>
                        </div>
                    </div>
                `;

                frag.appendChild(card);
            });

            this.grid.appendChild(frag);
        },
        decodeMaybe(text) {
            const raw = this.normalizeText(text, '');
            if (!raw) return '';
            if (/%[0-9A-Fa-f]{2}/.test(raw) && !/\\s/.test(raw)) {
                try { return decodeURIComponent(raw); } catch { return raw; }
            }
            return raw;
        },
        copy(textOrEncoded) {
            const text = this.decodeMaybe(textOrEncoded);
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(() => {
                    showToast('提示词已复制！');
                }).catch(() => {
                    this.fallbackCopy(text);
                });
            } else {
                this.fallbackCopy(text);
            }
        },
        fallbackCopy(text) {
            const textArea = document.createElement("textarea");
            textArea.value = text;
            textArea.style.position = "fixed";
            textArea.style.left = "-9999px";
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            try {
                const successful = document.execCommand('copy');
                if(successful) showToast('提示词已复制！');
                else alert('复制失败');
            } catch (err) {
                alert('浏览器不支持自动复制');
            }
            document.body.removeChild(textArea);
        },
        // 发送到对话框
        sendToInput(encodedText, shouldSend = false) {
            const text = this.decodeMaybe(encodedText);
            const textarea = document.getElementById('user-input');
            if (textarea) {
                textarea.value = text;
                adjustTextareaHeight();
                checkInput();
                textarea.focus();

                // 关闭模态框
                this.close();

                // 如果需要直接发送
                if (shouldSend) {
                    setTimeout(() => {
                        sendMessage();
                    }, 100);
                } else {
                    showToast('提示词已填充到输入框', 'success');
                }
            }
        },
        // 保存到我的提示词
        saveToCustom(encodedTitle, encodedPrompt) {
            const title = this.decodeMaybe(encodedTitle);
            const prompt = this.decodeMaybe(encodedPrompt);

            // 检查是否已存在
            if (!CustomPromptTool.allPrompts) {
                CustomPromptTool.init();
            }

            const exists = CustomPromptTool.allPrompts.some(p =>
                p.title === title || p.content === prompt
            );

            if (exists) {
                showToast('该提示词已存在于我的提示词中', 'warning', 2000);
                return;
            }

            // 添加到我的提示词
            CustomPromptTool.allPrompts.unshift({
                id: 'prompt_' + Date.now(),
                title: title,
                content: prompt,
                createdAt: Date.now(),
                updatedAt: Date.now()
            });

            CustomPromptTool.savePrompts();
            showToast('已保存到我的提示词', 'success', 2000);
        }
    };


    // === Custom Prompt Tool ===
    const CustomPromptTool = {
        modal: null, listEl: null, emptyEl: null,
        allPrompts: [], searchTerm: '',

        init() {
            this.modal = document.getElementById('custom-prompt-modal');
            this.listEl = document.getElementById('custom-prompt-list');
            this.emptyEl = document.getElementById('custom-prompt-empty');
            this.loadPrompts();
        },

        open() {
            if (!this.modal) this.init();
            closeAllSidebars();
            this.modal.classList.add('active');
            this.render();
        },

        close() {
            this.modal.classList.remove('active');
        },

        loadPrompts() {
            try {
                this.allPrompts = JSON.parse(localStorage.getItem('custom_prompts') || '[]');
            } catch (e) {
                console.error('Failed to load custom prompts:', e);
                this.allPrompts = [];
            }
        },

        savePrompts() {
            try {
                localStorage.setItem('custom_prompts', JSON.stringify(this.allPrompts));
            } catch (e) {
                console.error('Failed to save custom prompts:', e);
                showToast('保存失败', 'error');
            }
        },

        save() {
            const title = document.getElementById('custom-prompt-title').value.trim();
            const content = document.getElementById('custom-prompt-content').value.trim();
            const editId = document.getElementById('custom-prompt-edit-id').value;

            if (!title) {
                showToast('请输入标题', 'warning');
                return;
            }

            if (!content) {
                showToast('请输入提示词内容', 'warning');
                return;
            }

            if (editId) {
                // 编辑模式
                const index = this.allPrompts.findIndex(p => p.id === editId);
                if (index > -1) {
                    this.allPrompts[index] = {
                        id: editId,
                        title: title,
                        content: content,
                        createdAt: this.allPrompts[index].createdAt,
                        updatedAt: Date.now()
                    };
                    showToast('更新成功', 'success');
                }
            } else {
                // 新增模式
                this.allPrompts.unshift({
                    id: 'prompt_' + Date.now(),
                    title: title,
                    content: content,
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                });
                showToast('保存成功', 'success');
            }

            this.savePrompts();
            this.clearForm();
            this.render();
        },

        delete(id) {
            if (!confirm('确定要删除这条提示词吗？')) return;

            this.allPrompts = this.allPrompts.filter(p => p.id !== id);
            this.savePrompts();
            this.render();
            showToast('已删除', 'success');
        },

        edit(id) {
            const prompt = this.allPrompts.find(p => p.id === id);
            if (!prompt) return;

            document.getElementById('custom-prompt-title').value = prompt.title;
            document.getElementById('custom-prompt-content').value = prompt.content;
            document.getElementById('custom-prompt-edit-id').value = prompt.id;
            document.getElementById('custom-prompt-form-title').textContent = '编辑提示词';

            // 滚动到顶部
            const container = this.modal.querySelector('[style*="padding-top: 80px"]');
            if (container) container.scrollTop = 0;
        },

        clearForm() {
            document.getElementById('custom-prompt-title').value = '';
            document.getElementById('custom-prompt-content').value = '';
            document.getElementById('custom-prompt-edit-id').value = '';
            document.getElementById('custom-prompt-form-title').textContent = '新建提示词';
        },

        handleSearch(val) {
            this.searchTerm = val.toLowerCase().trim();
            this.render();
        },

        usePrompt(id, sendDirect = false) {
            const prompt = this.allPrompts.find(p => p.id === id);
            if (!prompt) return;

            // 关闭模态框
            this.close();

            // 填充到输入框
            const textarea = document.getElementById('user-input');
            if (textarea) {
                textarea.value = prompt.content;
                adjustTextareaHeight();
                checkInput();
                textarea.focus();

                // 如果是直接发送，则调用发送函数
                if (sendDirect) {
                    setTimeout(() => {
                        sendMessage();
                    }, 100);
                } else {
                    showToast('提示词已填充', 'success');
                }
            }
        },

        render() {
            this.listEl.innerHTML = '';

            // 搜索过滤
            let filtered = this.allPrompts;
            if (this.searchTerm) {
                filtered = this.allPrompts.filter(p => {
                    const title = p.title.toLowerCase();
                    const content = p.content.toLowerCase();
                    return title.includes(this.searchTerm) || content.includes(this.searchTerm);
                });
            }

            // 显示空状态
            if (filtered.length === 0) {
                this.listEl.style.display = 'none';
                this.emptyEl.style.display = 'block';
                return;
            }

            this.listEl.style.display = 'grid';
            this.emptyEl.style.display = 'none';

            // 渲染列表
            filtered.forEach(prompt => {
                const card = document.createElement('div');
                card.className = 'banana-card';

                const preview = prompt.content.substring(0, 100) + (prompt.content.length > 100 ? '...' : '');
                const createdDate = new Date(prompt.createdAt).toLocaleDateString('zh-CN');

                card.innerHTML = `
                    <div class="banana-content" style="padding: 16px;">
                        <div class="banana-title" style="margin-bottom: 8px;">${escapeHtml(prompt.title)}</div>
                        <div class="banana-prompt-text" style="font-size: 12px; color: #666; line-height: 1.5; margin-bottom: 12px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;">
                            ${escapeHtml(preview)}
                        </div>
                        <div class="banana-footer" style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid #f0f0f0; padding-top: 12px; margin-top: 12px;">
                            <div class="banana-author" style="font-size: 11px; color: #999;">
                                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 4px;"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
                                ${createdDate}
                            </div>
                            <div class="banana-actions" style="display: flex; gap: 8px;">
                                <div class="banana-icon-btn" title="填充到输入框" onclick="CustomPromptTool.usePrompt('${prompt.id}', false)">
                                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                                </div>
                                <div class="banana-icon-btn" title="直接发送" onclick="CustomPromptTool.usePrompt('${prompt.id}', true)" style="color: #1a73e8;">
                                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
                                </div>
                                <div class="banana-icon-btn" title="编辑" onclick="CustomPromptTool.edit('${prompt.id}')">
                                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                                </div>
                                <div class="banana-icon-btn" title="删除" onclick="CustomPromptTool.delete('${prompt.id}')" style="color: #d93025;">
                                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                                </div>
                            </div>
                        </div>
                    </div>
                `;

                this.listEl.appendChild(card);
            });
        }
    };


    // --- IndexedDB for XHS History ---
    const XHSDb = {
        dbName: 'XHSHistoryDB', version: 1, storeName: 'history', db: null,
        async open() { if(this.db) return this.db; return new Promise((resolve, reject) => { const req = indexedDB.open(this.dbName, this.version); req.onupgradeneeded = (e) => { const db = e.target.result; if(!db.objectStoreNames.contains(this.storeName)) db.createObjectStore(this.storeName, { keyPath: 'id' }); }; req.onsuccess = (e) => { this.db = e.target.result; resolve(this.db); }; req.onerror = (e) => reject(e); }); },
        async add(item) { await this.open(); return new Promise((resolve, reject) => { const tx = this.db.transaction(this.storeName, 'readwrite'); tx.objectStore(this.storeName).put(item); tx.oncomplete = () => resolve(); tx.onerror = (e) => reject(e); }); },
        async getAll() { await this.open(); return new Promise((resolve, reject) => { const tx = this.db.transaction(this.storeName, 'readonly'); const req = tx.objectStore(this.storeName).getAll(); req.onsuccess = () => resolve(req.result.sort((a, b) => b.id - a.id)); req.onerror = (e) => reject(e); }); },
        async delete(id) { await this.open(); return new Promise((resolve, reject) => { const tx = this.db.transaction(this.storeName, 'readwrite'); tx.objectStore(this.storeName).delete(id); tx.oncomplete = () => resolve(); tx.onerror = (e) => reject(e); }); },
        async clear() { await this.open(); return new Promise((resolve, reject) => { const tx = this.db.transaction(this.storeName, 'readwrite'); tx.objectStore(this.storeName).clear(); tx.oncomplete = () => resolve(); tx.onerror = (e) => reject(e); }); }
    };

    function xhsStripCodeFences(text) {
        const input = String(text ?? '');
        return input.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
    }

    function xhsExtractFirstJsonObject(text) {
        const input = xhsStripCodeFences(text);
        const start = input.indexOf('{');
        if (start === -1) return input.trim();

        let depth = 0;
        let inString = false;
        let escape = false;

        for (let i = start; i < input.length; i++) {
            const ch = input[i];
            if (inString) {
                if (escape) {
                    escape = false;
                    continue;
                }
                if (ch === '\\') {
                    escape = true;
                    continue;
                }
                if (ch === '"') {
                    inString = false;
                    continue;
                }
                continue;
            }

            if (ch === '"') {
                inString = true;
                continue;
            }
            if (ch === '{') depth += 1;
            if (ch === '}') {
                depth -= 1;
                if (depth === 0) return input.slice(start, i + 1).trim();
            }
        }

        return input.slice(start).trim();
    }

    function xhsEscapeControlCharsInJsonStrings(jsonText) {
        const input = String(jsonText ?? '');
        let out = '';
        let inString = false;
        let escape = false;

        for (let i = 0; i < input.length; i++) {
            const ch = input[i];
            if (!inString) {
                out += ch;
                if (ch === '"') inString = true;
                continue;
            }

            if (escape) {
                escape = false;
                out += ch;
                continue;
            }

            if (ch === '\\') {
                escape = true;
                out += ch;
                continue;
            }

            if (ch === '"') {
                inString = false;
                out += ch;
                continue;
            }

            if (ch === '\n') { out += '\\n'; continue; }
            if (ch === '\r') { out += '\\r'; continue; }
            if (ch === '\t') { out += '\\t'; continue; }

            const code = ch.charCodeAt(0);
            if (code >= 0 && code < 0x20) {
                out += `\\u${code.toString(16).padStart(4, '0')}`;
                continue;
            }

            out += ch;
        }

        return out;
    }

    function xhsParseJsonLenient(rawText) {
        const jsonCandidate = xhsExtractFirstJsonObject(rawText);
        if (!jsonCandidate) throw new Error('模型未返回可解析的 JSON');

        try {
            return JSON.parse(jsonCandidate);
        } catch (err) {
            const repaired = xhsEscapeControlCharsInJsonStrings(jsonCandidate);
            return JSON.parse(repaired);
        }
    }

    function xhsSafeJsonParse(text) {
        const raw = String(text ?? '').trim();
        if (!raw) throw new Error('API 响应为空');

        try {
            return JSON.parse(raw);
        } catch (err) {
            const repaired = xhsEscapeControlCharsInJsonStrings(raw);
            return JSON.parse(repaired);
        }
    }

    function xhsTryParseOpenAISse(text) {
        const raw = String(text ?? '');
        if (!raw.includes('data:')) return null;

        const lines = raw.split(/\r?\n/);
        let fullContent = '';
        let lastObj = null;

        for (const line of lines) {
            const match = line.match(/^data:\s*(.*)$/);
            if (!match) continue;

            const payload = (match[1] || '').trim();
            if (!payload || payload === '[DONE]') continue;

            let obj = null;
            try {
                obj = xhsSafeJsonParse(payload);
            } catch (_) {
                continue;
            }

            lastObj = obj;
            const delta = obj?.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta) {
                fullContent += delta;
            }

            const msg = obj?.choices?.[0]?.message?.content;
            if (!fullContent && typeof msg === 'string' && msg) {
                fullContent = msg;
            }
        }

        if (fullContent) {
            return { choices: [{ message: { content: fullContent } }] };
        }

        return lastObj;
    }

    async function xhsReadJsonResponse(res, options = {}) {
        const allowSse = !!options.allowSse;
        const text = await res.text().catch(() => '');
        if (!text) throw new Error('API 响应为空');

        if (allowSse) {
            const sseObj = xhsTryParseOpenAISse(text);
            if (sseObj) return sseObj;
        }

        return xhsSafeJsonParse(text);
    }

    // --- XHS Creator Logic (V7 Enhanced) ---
    const XHSCreator = {
        modal: null, topicInput: null, refImages: [], outlineData: null, isHistoryLoad: false,
        init() {
            this.modal = document.getElementById('xhs-modal');
            this.topicInput = document.getElementById('xhs-topic');
            this.previewBox = document.getElementById('xhs-previews');
            this.loadTextSettings();
            this.renderHistory();
        },
        open() {
            if(!this.modal) this.init();
            closeAllSidebars();
            this.modal.classList.add('active');
            this.loadTextSettings();
            this.renderHistory();
            try {
                if (!sessionStorage.getItem('xhs_guide_shown')) {
                    sessionStorage.setItem('xhs_guide_shown', '1');
                    const sidebar = document.getElementById('xhs-sidebar');
                    if (sidebar && sidebar.classList.contains('collapsed')) {
                        toggleXHSSidebar();
                    }
                    setTimeout(() => {
                        showToast('提示：左上角按钮可展开文案配置/历史；右上角齿轮可打开“API 渠道管理”', 'default', 4500);
                    }, 200);
                }
            } catch (_) {}
        },
        close() { this.modal.classList.remove('active'); },
        
        quickSelectModel(modelName) {
            if (modelName) {
                document.getElementById('xhs-text-model').value = modelName;
            }
        },
        
        loadTextSettings() {
            document.getElementById('xhs-text-api-host').value = localStorage.getItem('xhs_text_api_host') || 'https://api.openai.com';
            document.getElementById('xhs-text-api-key').value = localStorage.getItem('xhs_text_api_key') || '';
            document.getElementById('xhs-text-model').value = localStorage.getItem('xhs_text_model') || 'gpt-4o';
            this.loadCustomModels();
        },
        
        saveTextSettings() {
            localStorage.setItem('xhs_text_api_host', document.getElementById('xhs-text-api-host').value);
            localStorage.setItem('xhs_text_api_key', document.getElementById('xhs-text-api-key').value);
            localStorage.setItem('xhs_text_model', document.getElementById('xhs-text-model').value);
            showToast('配置已保存', 'success');
        },
        
        loadCustomModels() {
            const customModels = JSON.parse(localStorage.getItem('xhs_custom_models') || '[]');
            const group = document.getElementById('xhs-custom-models-group');
            
            if (customModels.length === 0) {
                group.style.display = 'none';
                group.innerHTML = '';
            } else {
                group.style.display = 'block';
                group.innerHTML = customModels.map(model => 
                    `<option value="${model}">${model}</option>`
                ).join('');
            }
        },
        
        addCustomModel() {
            const modelName = document.getElementById('xhs-text-model').value.trim();
            
            if (!modelName) {
                showToast('请先输入模型名称', 'warning');
                return;
            }
            
            const customModels = JSON.parse(localStorage.getItem('xhs_custom_models') || '[]');
            
            if (customModels.includes(modelName)) {
                showToast('该模型已存在于自定义列表', 'warning');
                return;
            }
            
            customModels.push(modelName);
            localStorage.setItem('xhs_custom_models', JSON.stringify(customModels));
            
            this.loadCustomModels();
            showToast(`已添加 "${modelName}" 到自定义模型`, 'success');
        },
        
        removeCustomModel() {
            const modelName = document.getElementById('xhs-text-model').value.trim();
            
            if (!modelName) {
                showToast('请先输入或选择要删除的模型名称', 'warning');
                return;
            }
            
            const customModels = JSON.parse(localStorage.getItem('xhs_custom_models') || '[]');
            const index = customModels.indexOf(modelName);
            
            if (index === -1) {
                showToast('该模型不在自定义列表中', 'warning');
                return;
            }
            
            if (!confirm(`确定要删除自定义模型 "${modelName}" 吗？`)) {
                return;
            }
            
            customModels.splice(index, 1);
            localStorage.setItem('xhs_custom_models', JSON.stringify(customModels));
            
            this.loadCustomModels();
            document.getElementById('xhs-text-model').value = '';
            showToast(`已删除 "${modelName}"`, 'success');
        },

        handleFiles(files) {
            if (files.length + this.refImages.length > 4) { alert("最多4张"); return; }
            Array.from(files).forEach(file => {
                const reader = new FileReader(); reader.onload = (e) => {
                    const img = new Image(); img.src = e.target.result; img.onload = () => {
                         const canvas = document.createElement('canvas'); const max = 1024; let w = img.width, h = img.height; if (w > h) { if (w > max) { h *= max/w; w = max; } } else { if (h > max) { w *= max/h; h = max; } } canvas.width = w; canvas.height = h; canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                         const dataUrl = canvas.toDataURL('image/jpeg', 0.8); this.refImages.push({ src: dataUrl }); this.renderPreviews();
                    }
                }; reader.readAsDataURL(file);
            });
        },
        renderPreviews() {
            this.previewBox.innerHTML = this.refImages.map((img, i) => `<div class="xhs-preview-item"><img class="xhs-preview-img" src="${img.src}"><div class="xhs-preview-del" onclick="XHSCreator.removeImg(${i})">×</div></div>`).join('');
        },
        removeImg(i) { this.refImages.splice(i, 1); this.renderPreviews(); },

        async saveToHistory(data) { const entry = { id: data.id || Date.now(), timestamp: new Date().toLocaleString(), title: data.title, data: data }; await XHSDb.add(entry); this.renderHistory(); },
        async renderHistory() { const listEl = document.getElementById('xhs-history-list'); if (!listEl) return; const history = await XHSDb.getAll(); if (history.length === 0) { listEl.innerHTML = '<div style="text-align:center;color:#999;font-size:12px;margin-top:20px">暂无记录</div>'; return; } listEl.innerHTML = history.map(item => `<div class="xhs-history-item" onclick="XHSCreator.loadFromHistory(${item.id})"><div class="xhs-h-title">${escapeHtml(item.title)}</div><div class="xhs-h-date">${item.timestamp}</div></div>`).join(''); },
        async loadFromHistory(id) { const history = await XHSDb.getAll(); const item = history.find(i => i.id === id); if (item) { this.outlineData = item.data; if(!this.outlineData.id) this.outlineData.id = item.id; this.isHistoryLoad = true; this.renderOutline(); } },
        async clearHistory() { if (confirm('清空所有记录？')) { await XHSDb.clear(); this.renderHistory(); } },

        copyContent(type) { if(!this.outlineData) return; navigator.clipboard.writeText(type === 'title' ? this.outlineData.title : this.outlineData.content).then(() => showToast('已复制')); },
        async generateOutline() {
            const topic = this.topicInput.value.trim();
            const imgCount = document.getElementById('xhs-img-count').value || 4;
            
            // 获取文案生成API配置：优先使用 XHS 独立配置；若未填写完整则回退到右侧「API 渠道」配置
            const xhsHost = document.getElementById('xhs-text-api-host').value.trim().replace(/\/+$/, '');
            const xhsKey = document.getElementById('xhs-text-api-key').value.trim();
            const xhsModel = document.getElementById('xhs-text-model').value.trim();

            const provider = ProviderManager && typeof ProviderManager.getConfig === 'function' ? ProviderManager.getConfig() : null;
            const textConfig = (xhsHost && xhsKey && xhsModel)
                ? { source: 'xhs', type: 'openai', host: xhsHost, key: xhsKey, model: xhsModel }
                : (provider ? { source: 'provider', ...provider } : null);

            if (!textConfig || !textConfig.host || !textConfig.key || !textConfig.model) {
                showToast('请先配置文案生成 API（右侧“API 渠道管理”，或点左上角按钮展开本页左侧配置）', 'warning', 3800);
                toggleSettings(true);
                const xhsSidebar = document.getElementById('xhs-sidebar');
                if (xhsSidebar && xhsSidebar.classList.contains('collapsed')) {
                    toggleXHSSidebar();
                }
                return;
            }
            
            if (!topic && this.refImages.length === 0) {
                showToast('请输入主题或上传参考图片', 'warning', 3000);
                return;
            }

            const btn = document.getElementById('xhs-generate-btn');
            btn.disabled = true;
            btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px;"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>正在策划...';

            // 显示加载状态
            LoadingManager.show('正在生成创意方案...');

            const systemPrompt = `你是一位资深的小红书内容策划专家，擅长爆款笔记创作和视觉设计。

## 你的任务
根据用户提供的主题和参考图片，策划一篇完整的小红书笔记，包括标题、正文和配图方案。

## 分析要求
1. **理解用户需求**：仔细分析用户的主题描述和上传的参考图片
2. **提取视觉风格**：如果有参考图，分析其色彩、构图、氛围、风格特征
3. **匹配内容调性**：根据主题选择合适的表达风格（种草/教程/测评/OOTD/Vlog等）

## 输出规范
只输出严格的 **JSON格式**（不要任何解释、不要 Markdown、不要代码块），结构如下：

{
  "title": "爆款标题（必须包含emoji，控制在20字内，使用数字/符号/反问/悬念等技巧）",
  "content": "正文内容（分段清晰，每段加emoji，自然融入3-5个话题标签如#标签，语气亲切真实，避免广告感；如需换行用\\n，不要直接换行）",
  "shots": [
    {
      "desc": "图1-封面图：简短描述图片用途和重点",
      "prompt": "详细的画面描述（中文）：\\n- 主体：具体描述主要元素、人物动作、产品特写等\\n- 环境：场景氛围、背景元素、空间感\\n- 色彩：主色调、配色方案（参考风格图）\\n- 光影：光线方向、明暗对比、氛围营造\\n- 风格：摄影风格、构图方式、视觉质感\\n- 细节：重要的装饰元素、文字排版位置等\\n\\n要求：画面精致、符合小红书审美、适合${this.outlineData?.shots?.[0]?.refImage ? '参考图风格' : '当前主题'}"
    }
  ]
}

## 创作原则
- **标题**：吸睛但不夸张，真实但有亮点
- **正文**：口语化表达，分享感强，有价值有共鸣
- **配图**：每张图都有明确目的，视觉连贯统一
- **图片描述**：足够详细，让AI能准确生成理想画面

## 注意事项
- shots数组长度必须为 ${imgCount} 张
- 所有prompt必须用中文描述，不要出现英文
- 如果用户上传了参考图，必须在prompt中体现参考图的风格特征
- JSON 的字符串里不要出现真实换行符/Tab 等控制字符（需要换行请用\\n）
- 确保 JSON 格式完全正确，可以被直接解析`;

            try {
                let data = null;
                if (textConfig.type === 'openai') {
                    // OpenAI 兼容格式
                    let contentPayload = [{ type: "text", text: systemPrompt + "\n\n需求：" + topic }];
                    this.refImages.forEach(imgObj => {
                        contentPayload.push({
                            type: "image_url",
                            image_url: { url: imgObj.src }
                        });
                    });

                    const requestBody = {
                        model: textConfig.model,
                        stream: false,
                        messages: [{
                            role: "user",
                            content: contentPayload
                        }]
                    };

                    const res = await nativeFetch(`${textConfig.host.replace(/\/$/,'')}/v1/chat/completions`, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${textConfig.key}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(requestBody)
                    });

                    if (!res.ok) {
                        const errorText = await res.text().catch(() => '');
                        throw new Error(`HTTP ${res.status}: ${errorText || res.statusText}`);
                    }

                    data = await xhsReadJsonResponse(res, { allowSse: true });
                } else {
                    // Gemini 原生格式
                    const parts = [{ text: systemPrompt + "\n\n需求：" + topic }];
                    this.refImages.forEach(imgObj => {
                        const src = (imgObj && imgObj.src) ? String(imgObj.src) : '';
                        if (!src) return;
                        if (src.startsWith('data:image/')) {
                            const base64 = src.split(',')[1];
                            if (base64) {
                                parts.push({ inline_data: { mime_type: 'image/jpeg', data: base64 } });
                            }
                            return;
                        }
                        // 对于 http(s) 图片，Gemini 端无法直接拉取，退化为只发文本（避免跨域/下载问题）
                    });

                    const payload = {
                        contents: [{ role: "user", parts }],
                        generationConfig: { responseModalities: ["TEXT"] }
                    };

                    const requestUrl = `${textConfig.host.replace(/\/$/,'')}/v1beta/models/${textConfig.model}:generateContent`;
                    const res = await nativeFetch(requestUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-goog-api-key': textConfig.key
                        },
                        body: JSON.stringify(payload)
                    });

                    if (!res.ok) {
                        const errorText = await res.text().catch(() => '');
                        throw new Error(`HTTP ${res.status}: ${errorText || res.statusText}`);
                    }

                    data = await xhsReadJsonResponse(res);
                }

                if (data.error) {
                    throw new Error(data.error.message || 'API返回错误');
                }

                LoadingManager.updateText('正在解析方案...');

                let rawText = '';
                if (data.choices?.[0]?.message?.content) {
                    rawText = data.choices[0].message.content;
                } else if (data.candidates?.[0]?.content?.parts) {
                    rawText = data.candidates[0].content.parts.map(p => p.text || '').join('');
                }

                let parsed;
                if (rawText) {
                    try {
                        parsed = xhsParseJsonLenient(rawText);
                    } catch (parseError) {
                        const detail = parseError && parseError.message ? parseError.message : String(parseError || 'JSON解析失败');
                        throw new Error(`模型返回的方案不是严格 JSON（已尝试自动修复仍失败）：${detail}`);
                    }
                } else if (data && typeof data === 'object' && Array.isArray(data.shots) && (typeof data.title === 'string' || typeof data.content === 'string')) {
                    // 兼容部分渠道直接返回最终结构（无 OpenAI/Gemini 包装）
                    parsed = data;
                } else {
                    throw new Error('API未返回文案内容');
                }

                if (!parsed || typeof parsed !== 'object') {
                    throw new Error('模型返回内容不是 JSON 对象');
                }
                if (!Array.isArray(parsed.shots)) {
                    throw new Error('模型返回的 shots 字段不是数组');
                }

                // 兼容模型把换行写成 "\\n" 的情况，统一还原为真实换行，避免渲染/生成 prompt 体验差
                const normalizeText = (value) => (typeof value === 'string' ? value.replace(/\\n/g, '\n').replace(/\\r/g, '\r') : value);
                parsed.title = normalizeText(parsed.title);
                parsed.content = normalizeText(parsed.content);
                parsed.shots = parsed.shots.map(s => ({
                    ...s,
                    desc: normalizeText(s?.desc),
                    prompt: normalizeText(s?.prompt)
                }));

                this.outlineData = parsed;
                this.outlineData.id = Date.now();

                if(this.refImages.length > 0) {
                    const defRef = this.refImages[0].src;
                    this.outlineData.shots.forEach(s => s.refImage = defRef);
                }

                await this.saveToHistory(this.outlineData);
                this.renderOutline();

                LoadingManager.hide();
                showToast('创意方案生成成功！', 'success');

            } catch (e) {
                LoadingManager.hide();
                ErrorHandler.handleAPIError(e, '生成方案');
                console.error('Generate outline error:', e);
            } finally {
                btn.disabled = false;
                btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px;"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>生成方案';
            }
        },

        renderOutline() {
            document.getElementById('xhs-text-result').style.display = 'block';
            document.getElementById('xhs-content-viewer').innerHTML = typeof marked !== 'undefined' ? `<h3>${this.outlineData.title}</h3>` + marked.parse(this.outlineData.content) : `<h3>${this.outlineData.title}</h3><div style="white-space:pre-wrap">${this.outlineData.content}</div>`;

            const list = document.getElementById('xhs-shot-list');
            
            if (!this.outlineData.shots || this.outlineData.shots.length === 0) {
                list.innerHTML = '<div style="text-align:center;padding:40px;color:#999;">暂无分镜数据</div>';
                return;
            }
            
            list.innerHTML = this.outlineData.shots.map((shot, index) => {
                const hasImage = !!shot.imageData;
                const safePrompt = (shot.prompt || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
                
                let refHtml = shot.refImage ?
                    `<div class="ref-capsule" onclick="event.stopPropagation()">
                        <img src="${shot.refImage}" class="ref-thumb">
                        <span class="ref-info">垫图</span>
                        <div class="ref-actions">
                            <div class="ref-icon-btn" title="更换" onclick="event.stopPropagation(); document.getElementById('ref-file-${index}').click()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></div>
                            <div class="ref-icon-btn del" title="删除" onclick="event.stopPropagation(); XHSCreator.removeRefImage(${index})"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></div>
                        </div>
                    </div>` :
                    `<div class="add-ref-btn" onclick="event.stopPropagation(); document.getElementById('ref-file-${index}').click()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg> 垫图</div>`;

                return `
                <div class="shot-card">
                    <div class="shot-img-wrap" id="img-box-${index}" onclick="if(this.querySelector('.shot-img').src) openLightbox(this.querySelector('.shot-img').src)">
                         <div class="shot-loading" id="loading-${index}" style="display:none;position:absolute;inset:0;justify-content:center;align-items:center;background:rgba(255,255,255,0.95);z-index:50;flex-direction:column;gap:8px;">
                            <div class="loading-spinner"></div>
                            <div style="color:#666;font-size:12px;margin-top:4px;">生成中...</div>
                            <div style="width:80%;margin-top:8px;">
                                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                                    <span style="font-size:11px;color:#666;">进度</span>
                                    <span id="xhs-progress-${index}-text" style="font-size:11px;color:#1967d2;font-weight:600;">0%</span>
                                </div>
                                <div style="width:100%;height:4px;background:#e8eaed;border-radius:2px;overflow:hidden;">
                                    <div id="xhs-progress-${index}" style="width:0%;height:100%;background:#1967d2;border-radius:2px;transition:width 0.3s ease;"></div>
                                </div>
                            </div>
                         </div>
                         <img class="shot-img"
    id="res-img-${index}"
    src="${hasImage ? shot.imageData : ''}"
    style="opacity:${hasImage ? '1' : '0'}"
    onerror="console.error('Image load error:', this.src)"
>
                         ${refHtml}
                    </div>
                    <div class="shot-body">
                        <div class="shot-title"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px;"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>图 ${index+1}</div>
                        <textarea class="shot-prompt" id="prompt-${index}">${safePrompt}</textarea>
                        <input type="file" id="ref-file-${index}" hidden accept="image/*" onchange="XHSCreator.changeRefImage(${index}, this.files)">
                        <div class="shot-footer">
                            <div class="action-pill download-pill-${index}" onclick="XHSCreator.downloadImage(${index})" style="display:${hasImage?'flex':'none'}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> 下载</div>
                            <div class="action-pill regen" onclick="XHSCreator.regenerateSingleImage(${index})"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> 重绘</div>
                        </div>
                    </div>
                </div>`;
            }).join('');

            setTimeout(() => {
                const rightPanel = document.querySelector('.xhs-right');
                if (rightPanel) rightPanel.scrollTop = 0;
            }, 100);
            this.isHistoryLoad = false;
        },

        removeRefImage(index) { this.outlineData.shots[index].refImage = null; this.saveToHistory(this.outlineData); this.renderOutline(); },
        changeRefImage(index, files) {
            if(files.length===0) return; const reader = new FileReader();
            reader.onload = (e) => { const img = new Image(); img.src = e.target.result; img.onload = () => { const canvas = document.createElement('canvas'); const max = 800; let w=img.width,h=img.height; if(w>h){if(w>max){h*=max/w;w=max}}else{if(h>max){w*=max/h;h=max}} canvas.width=w;canvas.height=h; canvas.getContext('2d').drawImage(img,0,0,w,h); this.outlineData.shots[index].refImage = canvas.toDataURL('image/jpeg', 0.8); this.saveToHistory(this.outlineData); this.renderOutline(); } }; reader.readAsDataURL(files[0]);
        },
        async startPainting() {
            const config = ProviderManager.getConfig();
            if (!config) {
                showToast('请先配置绘图API', 'warning', 3000);
                return;
            }

            const total = this.outlineData.shots.length;
            let completed = 0;

            // 显示进度条
            ProgressBar.show();
            ProgressBar.setProgress(0);
            showToast(`开始批量生成 ${total} 张图片...`, 'info', 2000);

            // 批量生成：按“同时生成图片数量”限制并发（1-4）
            const limit = Math.min(4, Math.max(1, Number(state.concurrentImageCount || 1)));
            let nextIndex = 0;

            const runOne = async (i) => {
                try {
                    await this.regenerateSingleImage(i);
                } catch (e) {
                    console.error(`Image ${i} generation failed:`, e);
                } finally {
                    completed++;
                    const progress = (completed / total) * 100;
                    ProgressBar.setProgress(progress);

                    if (completed === total) {
                        ProgressBar.hide();
                        showToast('所有图片生成完成！', 'success', 3000);

                        setTimeout(() => {
                            const rightPanel = document.querySelector('.xhs-right');
                            if (rightPanel) {
                                rightPanel.scrollTop = 0;
                            }
                        }, 500);
                    } else {
                        const firstGeneratedCard = document.querySelector('.shot-img[style*="opacity: 1"]')?.closest('.shot-card');
                        if (firstGeneratedCard && completed === 1) {
                            setTimeout(() => {
                                firstGeneratedCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
                            }, 300);
                        }
                    }
                }
            };

            const workers = Array.from({ length: Math.min(limit, total) }, async () => {
                while (true) {
                    const i = nextIndex++;
                    if (i >= total) break;
                    await runOne(i);
                }
            });

            await Promise.all(workers);
        },
        async downloadImage(index) { 
            const img = document.getElementById(`res-img-${index}`); 
            if(img && img.src && img.src.startsWith('data:')) { 
                const filename = `xhs_${Date.now()}.png`;
                downloadImage(img.src, filename);
            } else {
                showToast('图片未生成或加载失败', 'warning');
            }
        },

        async regenerateSingleImage(index) {
            const config = ProviderManager.getConfig();
            if (!config) {
                showToast('请先配置绘图API', 'warning');
                return;
            }

            const prompt = document.getElementById(`prompt-${index}`).value;
            if(!prompt) {
                showToast('提示词不能为空', 'warning');
                return;
            }

            const loading = document.getElementById(`loading-${index}`);
            const imgEl = document.getElementById(`res-img-${index}`);
            const box = document.getElementById(`img-box-${index}`);

            // 移除旧的错误提示
            const oldErr = box.querySelector('.shot-error');
            if(oldErr) oldErr.remove();

            loading.style.display = 'flex';

            // 启动进度条
            const progressId = `xhs-progress-${index}`;
            const quality = document.getElementById('xhs-paint-quality').value;
            const hasRefImages = !!this.outlineData.shots[index].refImage;
            SmartProgressBar.start(progressId, quality, hasRefImages);

            try {
                let finalBase64 = null;

                if (config.type === 'openai') {
                    const messages = [{
                        role: "user",
                        content: [{ type: "text", text: prompt }]
                    }];

                    if(this.outlineData.shots[index].refImage) {
                        messages[0].content.push({
                            type: "image_url",
                            image_url: { url: this.outlineData.shots[index].refImage }
                        });
                    }

                    const aspectRatio = document.getElementById('xhs-paint-ratio').value;
                    const quality = document.getElementById('xhs-paint-quality').value;
                    let size = "1024x1024";
                    if (quality === "2K") size = "2048x2048";
                    else if (quality === "4K") size = "4096x4096";

                    const useStreaming = document.getElementById('stream-toggle')?.checked || false;

                    const payload = {
                        model: config.model,
                        messages: messages,
                        stream: useStreaming,
                        size: size,
                        aspect_ratio: aspectRatio !== "3:4" ? aspectRatio : undefined
                    };

                    // 构建请求 URL
                    const requestUrl = `${config.host.replace(/\/$/,'')}/v1/chat/completions`;

                    // 构建请求 headers
                    const requestHeaders = {
                        'Authorization': `Bearer ${config.key}`,
                        'Content-Type': 'application/json'
                    };

                    const res = await nativeFetch(requestUrl, {
                        method: 'POST',
                        headers: requestHeaders,
                        body: JSON.stringify(payload)
                    });

                    if (!res.ok) {
                        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
                    }

                    let content;
                    if (useStreaming) {
                        const reader = res.body.getReader();
                        const decoder = new TextDecoder();
                        let buffer = '';
                        let fullContent = '';
                        
                        while (true) {
                            const {done, value} = await reader.read();
                            if (done) break;
                            
                            buffer += decoder.decode(value, {stream: true});
                            const lines = buffer.split('\n');
                            buffer = lines.pop();
                            
                            for (const line of lines) {
                                if (line.startsWith('data: ')) {
                                    const data = line.slice(6).trim();
                                    if (data === '[DONE]') continue;
                                    
                                    try {
                                        const json = JSON.parse(data);
                                        if (json.choices?.[0]?.delta?.content) {
                                            fullContent += json.choices[0].delta.content;
                                        }
                                    } catch (e) {
                                        console.warn('Parse SSE error:', e);
                                    }
                                }
                            }
                        }
                        content = fullContent;
                    } else {
                        const data = await res.json();
                        if (data.error) {
                            throw new Error(data.error.message || 'API返回错误');
                        }
                        content = data.choices?.[0]?.message?.content || '';
                    }

                    if (content) {
                        const dataUrlMatch = content.match(/!\[.*?\]\((data:image\/[^)]+)\)/);
                        const httpUrlMatch = content.match(/!\[.*?\]\((https?:\/\/[^)]+)\)/);
                        
                        if (dataUrlMatch) {
                            finalBase64 = dataUrlMatch[1].split(',')[1];
                        } else if (content.startsWith('data:image/')) {
                            finalBase64 = content.split(',')[1];
                        } else if (httpUrlMatch) {
                            const imageUrl = httpUrlMatch[1];
                            const imgRes = await fetch(imageUrl);
                            const blob = await imgRes.blob();
                            finalBase64 = await new Promise((resolve) => {
                                const reader = new FileReader();
                                reader.onloadend = () => resolve(reader.result.split(',')[1]);
                                reader.readAsDataURL(blob);
                            });
                        }
                    }

                } else {
                    const parts = [{ text: prompt }];
                    if(this.outlineData.shots[index].refImage) {
                        parts.push({
                            inline_data: {
                                mime_type: 'image/jpeg',
                                data: this.outlineData.shots[index].refImage.split(',')[1]
                            }
                        });
                    }

                    const payload = {
                        contents: [{ role: "user", parts: parts }],
                        generationConfig: {
                            responseModalities: ["IMAGE"],
                            imageConfig: {
                                imageSize: document.getElementById('xhs-paint-quality').value,
                                aspectRatio: document.getElementById('xhs-paint-ratio').value
                            }
                        }
                    };

                    // 构建请求 URL
                    const requestUrl = `${config.host.replace(/\/$/,'')}/v1beta/models/${config.model}:generateContent?key=${config.key}`;

                    // 构建请求 headers
                    const requestHeaders = {
                        'Content-Type': 'application/json'
                    };

                    const res = await nativeFetch(requestUrl, {
                        method: 'POST',
                        headers: requestHeaders,
                        body: JSON.stringify(payload)
                    });

                    if (!res.ok) {
                        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
                    }

                    const data = await res.json();

                    if (data.error) {
                        throw new Error(data.error.message || 'API返回错误');
                    }

                    if (data.candidates?.[0]?.content?.parts?.[0]?.inlineData) {
                        finalBase64 = data.candidates[0].content.parts[0].inlineData.data;
                    } else if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
                        const m = data.candidates[0].content.parts[0].text.match(/\((data:image\/[^;]+;base64,[^)]+)\)/);
                        if(m) finalBase64 = m[1].split(',')[1];
                    }
                }

                if (finalBase64) {
                    // 完成进度条
                    SmartProgressBar.complete(progressId);

                    const fullSrc = `data:image/jpeg;base64,${finalBase64}`;
                    imgEl.src = fullSrc;
                    imgEl.style.opacity = '1';
                    this.outlineData.shots[index].imageData = fullSrc;
                    this.outlineData.shots[index].prompt = prompt;

                    const downloadBtn = document.querySelector(`.download-pill-${index}`);
                    if (downloadBtn) downloadBtn.style.display = 'flex';

                    await this.saveToHistory(this.outlineData);
                } else {
                    throw new Error('API未返回图片数据');
                }

            } catch (e) {
                // 停止进度条
                SmartProgressBar.stop(progressId);

                console.error(`Image ${index} generation error:`, e);

                // 显示友好的错误信息
                let errorMsg = '生成失败';
                if (e.message.includes('401') || e.message.includes('403')) {
                    errorMsg = 'API密钥无效';
                } else if (e.message.includes('429')) {
                    errorMsg = '请求过于频繁';
                } else if (e.message.includes('500') || e.message.includes('502')) {
                    errorMsg = '服务器错误';
                } else if (e.message.includes('network') || e.message.includes('fetch')) {
                    errorMsg = '网络连接失败';
                } else if (e.message) {
                    errorMsg = e.message;
                }

                box.innerHTML += `<div class="shot-error">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-bottom:8px;">
                        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                    </svg>
                    <div>${errorMsg}</div>
                    <div style="font-size:11px;margin-top:4px;opacity:0.8;">点击"重绘"按钮重试</div>
                </div>`;

                throw e; // 重新抛出错误，让批量生成能够捕获
            } finally {
                loading.style.display = 'none';
            }
        }
    };

    // --- Slicer Logic ---
    const SlicerTool = {
        horizontalLines: [], verticalLines: [], isDragging: false, draggedLine: null, generatedBlobs: [],
        init() {
            this.modal = document.getElementById('slice-modal'); this.fileInput = document.getElementById('slice-file-input'); this.editorContainer = document.getElementById('slice-editor-container'); this.sourceImage = document.getElementById('slice-source-image'); this.emptyMsg = document.getElementById('slice-empty-msg'); this.overlay = document.getElementById('slice-overlay-canvas'); this.processBtn = document.getElementById('slice-process-btn'); this.clearBtn = document.getElementById('slice-clear-btn'); this.resultGrid = document.getElementById('slice-result-grid'); this.modeRadios = document.getElementsByName('slice-mode'); this.forceSquareCheckbox = document.getElementById('slice-force-square'); this.colorPickerBox = document.getElementById('slice-color-picker-box'); this.bgColorInput = document.getElementById('slice-bg-color'); this.downloadAllBtn = document.getElementById('slice-download-all-btn'); this.bindEvents();
        },
        openLocal() { this.modal.classList.add('active'); this.resetEditor(); this.sourceImage.src = ""; this.sourceImage.style.display = 'none'; this.emptyMsg.style.display = 'flex'; if(window.innerWidth > 768) setTimeout(() => this.fileInput.click(), 100); closeAllSidebars(); },
        open(imageUrl) { this.modal.classList.add('active'); this.emptyMsg.style.display = 'none'; this.sourceImage.crossOrigin = "Anonymous"; this.sourceImage.src = imageUrl; this.sourceImage.style.display = 'block'; this.sourceImage.onload = () => { this.resetEditor(); this.autoGrid(6, 4); }; this.sourceImage.onerror = () => { alert("无法加载该图片"); }; },
        close() { this.modal.classList.remove('active'); },
        resetEditor() { this.overlay.innerHTML = ''; this.horizontalLines = []; this.verticalLines = []; this.resultGrid.innerHTML = ''; this.processBtn.disabled = false; this.downloadAllBtn.disabled = true; this.generatedBlobs = []; this.emptyMsg.style.display = this.sourceImage.style.display === 'none' ? 'flex' : 'none'; },
        autoGrid(rows, cols) { for (let i = 1; i < rows; i++) this.addLine('h', (i / rows) * 100); for (let j = 1; j < cols; j++) this.addLine('v', (j / cols) * 100); },
        handleFile(files) { const file = files[0]; if (!file) return; const reader = new FileReader(); reader.onload = (event) => { this.emptyMsg.style.display = 'none'; this.sourceImage.style.display = 'block'; this.sourceImage.src = event.target.result; this.sourceImage.onload = () => this.resetEditor(); }; reader.readAsDataURL(file); },
        setMode(type, labelEl) { document.querySelectorAll('.radio-label').forEach(l => l.classList.remove('active')); labelEl.classList.add('active'); labelEl.querySelector('input').checked = true; },
        getPointerPos(e) { return (e.touches && e.touches.length > 0) ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : { x: e.clientX, y: e.clientY }; },
        bindEvents() {
            this.forceSquareCheckbox.addEventListener('change', (e) => this.colorPickerBox.style.display = e.target.checked ? 'flex' : 'none');
            this.overlay.addEventListener('click', (e) => { if (this.isDragging || e.target !== this.overlay) return; const rect = this.overlay.getBoundingClientRect(); const pos = this.getPointerPos(e); const x = pos.x - rect.left; const y = pos.y - rect.top; let mode = 'horizontal'; for(const r of this.modeRadios) if(r.checked) mode = r.value; if (mode === 'horizontal') this.addLine('h', (y / rect.height) * 100); else this.addLine('v', (x / rect.width) * 100); });
            this.clearBtn.addEventListener('click', () => { this.overlay.innerHTML = ''; this.horizontalLines = []; this.verticalLines = []; });
            this.processBtn.addEventListener('click', () => this.process());
        },
        addLine(type, percent) {
            const line = document.createElement('div'); line.classList.add('split-line', type === 'h' ? 'horizontal' : 'vertical'); const delBtn = document.createElement('div'); delBtn.className = 'delete-btn-line'; delBtn.innerText = '×';
            if(type === 'h') { line.style.top = percent + '%'; delBtn.style.right = '0'; delBtn.style.top = '-12px'; this.horizontalLines.push({ percent: percent, element: line }); } else { line.style.left = percent + '%'; delBtn.style.bottom = '-12px'; delBtn.style.left = '-12px'; this.verticalLines.push({ percent: percent, element: line }); }
            delBtn.addEventListener('click', (e) => { e.stopPropagation(); this.removeLine(line, type); }); delBtn.addEventListener('touchend', (e) => { e.preventDefault(); e.stopPropagation(); this.removeLine(line, type); });
            line.appendChild(delBtn); line.addEventListener('mousedown', (e) => this.startDrag(e, line, type)); line.addEventListener('touchstart', (e) => this.startDrag(e, line, type)); this.overlay.appendChild(line);
        },
        removeLine(element, type) { element.remove(); if (type === 'h') this.horizontalLines = this.horizontalLines.filter(l => l.element !== element); else this.verticalLines = this.verticalLines.filter(l => l.element !== element); },
        startDrag(e, element, type) {
            e.stopPropagation(); this.isDragging = true; this.draggedLine = { element, type };
            const moveHandler = (ev) => this.onDrag(ev);
            const upHandler = () => { this.isDragging = false; this.draggedLine = null; document.removeEventListener('mousemove', moveHandler); document.removeEventListener('mouseup', upHandler); document.removeEventListener('touchmove', moveHandler); document.removeEventListener('touchend', upHandler); setTimeout(() => { this.isDragging = false }, 50); };
            document.addEventListener('mousemove', moveHandler); document.addEventListener('mouseup', upHandler); document.addEventListener('touchmove', moveHandler, { passive: false }); document.addEventListener('touchend', upHandler);
        },
        onDrag(e) {
            if (!this.isDragging || !this.draggedLine) return; if (e.type === 'touchmove') e.preventDefault();
            const rect = this.overlay.getBoundingClientRect(); const pos = this.getPointerPos(e); let percent;
            if (this.draggedLine.type === 'h') { let y = Math.max(0, Math.min(pos.y - rect.top, rect.height)); percent = (y / rect.height) * 100; this.draggedLine.element.style.top = percent + '%'; const lineObj = this.horizontalLines.find(l => l.element === this.draggedLine.element); if(lineObj) lineObj.percent = percent; }
            else { let x = Math.max(0, Math.min(pos.x - rect.left, rect.width)); percent = (x / rect.width) * 100; this.draggedLine.element.style.left = percent + '%'; const lineObj = this.verticalLines.find(l => l.element === this.draggedLine.element); if(lineObj) lineObj.percent = percent; }
        },
        async process() {
            this.resultGrid.innerHTML = '<div style="width:100%;text-align:center;padding:20px;color:#666;">⚡ 正在处理...</div>';
            this.generatedBlobs = [];
            this.processBtn.disabled = true;
            this.downloadAllBtn.disabled = true;

            const imgRealWidth = this.sourceImage.naturalWidth;
            const imgRealHeight = this.sourceImage.naturalHeight;
            const isForceSquare = this.forceSquareCheckbox.checked;
            const fillColor = this.bgColorInput.value;

            let hCuts = this.horizontalLines.map(l => (l.percent / 100) * imgRealHeight);
            hCuts.push(0, imgRealHeight);
            hCuts.sort((a, b) => a - b);

            let vCuts = this.verticalLines.map(l => (l.percent / 100) * imgRealWidth);
            vCuts.push(0, imgRealWidth);
            vCuts.sort((a, b) => a - b);

            await new Promise(resolve => setTimeout(resolve, 50));

            this.resultGrid.innerHTML = '';
            const fragment = document.createDocumentFragment();
            const blobPromises = [];

            for (let i = 0; i < hCuts.length - 1; i++) {
                for (let j = 0; j < vCuts.length - 1; j++) {
                    const srcX = vCuts[j];
                    const srcY = hCuts[i];
                    const srcW = vCuts[j+1] - vCuts[j];
                    const srcH = hCuts[i+1] - hCuts[i];

                    if (srcW < 1 || srcH < 1) continue;

                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d', { alpha: true });

                    // 使用2x分辨率提高清晰度
                    const scale = 2;

                    if (isForceSquare) {
                        const maxDim = Math.max(srcW, srcH);
                        canvas.width = maxDim * scale;
                        canvas.height = maxDim * scale;

                        ctx.fillStyle = fillColor;
                        ctx.fillRect(0, 0, canvas.width, canvas.height);

                        ctx.imageSmoothingEnabled = true;
                        ctx.imageSmoothingQuality = 'high';

                        const offsetX = (maxDim - srcW) / 2;
                        const offsetY = (maxDim - srcH) / 2;
                        ctx.drawImage(
                            this.sourceImage,
                            srcX, srcY, srcW, srcH,
                            offsetX * scale, offsetY * scale, srcW * scale, srcH * scale
                        );
                    } else {
                        canvas.width = srcW * scale;
                        canvas.height = srcH * scale;

                        ctx.imageSmoothingEnabled = true;
                        ctx.imageSmoothingQuality = 'high';

                        ctx.drawImage(
                            this.sourceImage,
                            srcX, srcY, srcW, srcH,
                            0, 0, srcW * scale, srcH * scale
                        );
                    }

                    const itemName = `slice_${i+1}_${j+1}.png`;
                    const row = i;
                    const col = j;

                    const blobPromise = new Promise((resolve, reject) => {
                        try {
                            canvas.toBlob(blob => {
                                if (!blob) {
                                    reject(new Error('Failed to create blob'));
                                    return;
                                }

                                const blobUrl = BlobManager.create(blob);
                                this.generatedBlobs.push({ blob: blob, name: itemName });

                                const card = document.createElement('div');
                                card.className = 'slice-card';

                                const img = document.createElement('img');
                                img.src = blobUrl;
                                img.className = 'slice-img-result';

                                const info = document.createElement('div');
                                info.className = 'slice-info';
                                info.innerText = `${Math.round(canvas.width / scale)} x ${Math.round(canvas.height / scale)} (${scale}x)`;

                                card.onclick = () => {
                                    const a = document.createElement('a');
                                    a.href = blobUrl;
                                    a.download = itemName;
                                    a.click();
                                };

                                card.appendChild(img);
                                card.appendChild(info);
                                fragment.appendChild(card);

                                resolve();
                            }, 'image/png', 1.0);
                        } catch(e) {
                            reject(e);
                        }
                    });

                    blobPromises.push(blobPromise);
                }
            }

            try {
                await Promise.all(blobPromises);
                this.resultGrid.appendChild(fragment);
                this.downloadAllBtn.disabled = false;
                this.processBtn.disabled = false;
                showToast(`成功生成 ${this.generatedBlobs.length} 个切片`, 'success');
            } catch(e) {
                console.error('切片处理失败:', e);
                this.resultGrid.innerHTML = '<div style="width:100%;text-align:center;padding:20px;color:#d93025;">⚠️ 处理失败: ' + e.message + '</div>';
                this.processBtn.disabled = false;
            }
        },
        async downloadAll() { if(this.generatedBlobs.length === 0) return; if(typeof JSZip === 'undefined') { try { await loadJSZip(); } catch(e) { alert('JSZip 加载失败'); return; } } const zip = new JSZip(); const folder = zip.folder("slices"); this.generatedBlobs.forEach(item => folder.file(item.name, item.blob)); const content = await zip.generateAsync({type:"blob"}); const a = document.createElement('a'); a.href = URL.createObjectURL(content); a.download = `slices_${Date.now()}.zip`; a.click(); }
    };

    const ProviderManager={providers:[],activeId:'random',init(){try{this.providers=JSON.parse(localStorage.getItem('gemini_providers')||'[]');this.activeId=localStorage.getItem('gemini_active_provider')||'random';const oldHost=localStorage.getItem('api-host');if(oldHost&&this.providers.length===0){this.providers.push({id:'legacy_'+Date.now(),name:'默认渠道',type:'gemini',host:oldHost,key:localStorage.getItem('api-key')||'',model:localStorage.getItem('model-name')||'gemini-3-pro-image-preview'});this.saveToStorage()}}catch(e){console.error(e);this.providers=[]}this.renderUI()},saveToStorage(){localStorage.setItem('gemini_providers',JSON.stringify(this.providers));localStorage.setItem('gemini_active_provider',this.activeId)},renderUI(){const select=document.getElementById('provider-select');select.innerHTML='<option value="random">🎲 随机优选 (自动轮询)</option>';this.providers.forEach(p=>{const opt=document.createElement('option');opt.value=p.id;opt.text=p.name;if(p.id===this.activeId)opt.selected=true;select.appendChild(opt)});if(this.activeId==='random')select.value='random';const list=document.getElementById('provider-list');list.innerHTML='';this.providers.forEach(p=>{const div=document.createElement('div');div.className='provider-item';const typeLabel=p.type==='openai'?'[OpenAI]':'[Gemini]';div.innerHTML=`<span>${escapeHtml(p.name)} <span style="color:#1a73e8;font-size:9px;">${typeLabel}</span></span> <span style="color:#999; font-size:10px;">${escapeHtml(p.model)}</span>`;div.onclick=()=>this.loadForm(p);list.appendChild(div)})},loadForm(provider){document.getElementById('p-id').value=provider.id;document.getElementById('p-name').value=provider.name;document.getElementById('p-type').value=provider.type||'gemini';document.getElementById('p-host').value=provider.host;document.getElementById('p-key').value=provider.key;document.getElementById('p-model').value=provider.model;const items=document.querySelectorAll('.provider-item');items.forEach(el=>{if(el.textContent.includes(provider.name))el.classList.add('selected');else el.classList.remove('selected')})},clearForm(){document.getElementById('p-id').value='';document.getElementById('p-name').value='';document.getElementById('p-type').value='gemini';document.getElementById('p-host').value='';document.getElementById('p-key').value='';document.getElementById('p-model').value='';document.querySelectorAll('.provider-item').forEach(el=>el.classList.remove('selected'))},save(){const id=document.getElementById('p-id').value;const name=document.getElementById('p-name').value.trim();const type=document.getElementById('p-type').value;const host=document.getElementById('p-host').value.trim();const key=document.getElementById('p-key').value.trim();const model=document.getElementById('p-model').value.trim();if(!name||!host||!key||!model){alert("所有字段必填");return}if(id){const idx=this.providers.findIndex(p=>p.id===id);if(idx>-1)this.providers[idx]={id,name,type,host,key,model}}else{this.providers.push({id:'p_'+Date.now(),name,type,host,key,model})}this.saveToStorage();this.renderUI();this.clearForm()},del(){const id=document.getElementById('p-id').value;if(!id)return;if(!confirm("确定删除该渠道?"))return;this.providers=this.providers.filter(p=>p.id!==id);if(this.activeId===id)this.activeId='random';this.saveToStorage();this.renderUI();this.clearForm()},select(val){this.activeId=val;localStorage.setItem('gemini_active_provider',val)},getConfig(){if(this.providers.length===0)return null;if(this.activeId==='random'||!this.providers.find(p=>p.id===this.activeId)){const idx=Math.floor(Math.random()*this.providers.length);return this.providers[idx]}else{return this.providers.find(p=>p.id===this.activeId)}}};
    
    const DB_NAME='GeminiProDB';const DB_VERSION=2;let db=null;let currentSessionId=null;const activeGenerations=new Set();const activeGenerationCounts=new Map();
    function markGenerationStart(sessionId, count = 1){const sid=Number(sessionId)||sessionId;const cur=activeGenerationCounts.get(sid)||0;const next=Math.max(0,cur+Number(count||1));activeGenerationCounts.set(sid,next);activeGenerations.add(sid)}
    function markGenerationEnd(sessionId){const sid=Number(sessionId)||sessionId;const cur=activeGenerationCounts.get(sid)||0;const next=cur-1;if(next<=0){activeGenerationCounts.delete(sid);activeGenerations.delete(sid)}else{activeGenerationCounts.set(sid,next)}}
    function initDB(){return new Promise((resolve,reject)=>{const request=indexedDB.open(DB_NAME,DB_VERSION);request.onupgradeneeded=(e)=>{const db=e.target.result;if(!db.objectStoreNames.contains('sessions'))db.createObjectStore('sessions',{keyPath:'id'});if(!db.objectStoreNames.contains('messages')){const msgStore=db.createObjectStore('messages',{keyPath:'id',autoIncrement:true});msgStore.createIndex('sessionId','sessionId',{unique:false})}};request.onsuccess=(e)=>{db=e.target.result;resolve(db)};request.onerror=(e)=>reject(e)})}
    async function getAllSessions(){return new Promise((resolve)=>{const tx=db.transaction('sessions','readonly');const req=tx.objectStore('sessions').getAll();req.onsuccess=()=>resolve(req.result.sort((a,b)=>b.id-a.id))})}
    async function getSessionMessages(sessionId){return new Promise((resolve)=>{const tx=db.transaction('messages','readonly');const index=tx.objectStore('messages').index('sessionId');const req=index.getAll(sessionId);req.onsuccess=()=>resolve(req.result)})}
    async function saveMessage(sessionId,role,content,images=[],rawHtml=null){return new Promise((resolve)=>{const tx=db.transaction('messages','readwrite');const req=tx.objectStore('messages').add({sessionId,role,content,images,rawHtml,timestamp:Date.now()});req.onsuccess=()=>resolve(req.result)})}
    async function createSession(title="新对话"){const id=Date.now();const tx=db.transaction('sessions','readwrite');tx.objectStore('sessions').add({id,title,timestamp:id});return id}
    async function deleteSession(sessionId){const tx=db.transaction(['sessions','messages'],'readwrite');tx.objectStore('sessions').delete(sessionId);const index=tx.objectStore('messages').index('sessionId');index.openCursor(IDBKeyRange.only(sessionId)).onsuccess=(e)=>{const cursor=e.target.result;if(cursor){cursor.delete();cursor.continue()}};return new Promise(resolve=>tx.oncomplete=resolve)}
    async function deleteMessage(messageId){return new Promise((resolve)=>{const tx=db.transaction('messages','readwrite');const req=tx.objectStore('messages').delete(messageId);req.onsuccess=()=>resolve()})}
    async function updateSessionTitle(sessionId,title){const tx=db.transaction('sessions','readwrite');const store=tx.objectStore('sessions');store.get(sessionId).onsuccess=(e)=>{const data=e.target.result;if(data){data.title=title;store.put(data)}}}

    // 主题切换功能
    function initTheme() {
        const savedTheme = localStorage.getItem('theme') || 'light';
        document.documentElement.setAttribute('data-theme', savedTheme);
    }
    
    function toggleTheme() {
        const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
        const newTheme = currentTheme === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
        showToast(newTheme === 'dark' ? '已切换到暗黑模式 🌙' : '已切换到明亮模式 ☀️', 'success');
    }
    
    // 页面加载时初始化主题
    initTheme();
    
    const UI={chatHistory:document.getElementById('chat-history'),emptyState:document.getElementById('empty-state'),sessionList:document.getElementById('session-list'),textarea:document.getElementById('user-input'),fileInput:document.getElementById('file-input'),previewArea:document.getElementById('preview-area'),sendBtn:document.getElementById('send-btn')};const state={images:[],resolution:'4K',aspectRatio:'auto',useStreaming:false,useContext:false,contextCount:5,concurrentImageCount:1};
    
    window.onload = async () => {
        ProviderManager.init();
        XHSCreator.init();
        SlicerTool.init();
        BananaTool.init();
        CustomPromptTool.init();
        FileSystemManager.init();

        await initDB();
        await renderSessionList();

        const sessions = await getAllSessions();
        if (sessions.length > 0) await loadSession(sessions[0].id);
        else await createNewSession();

        // 右侧设置：默认常驻（桌面端），再次点击可隐藏
        try {
            const saved = localStorage.getItem('settings_open');
            const shouldOpen = saved === null ? true : saved === 'true';
            if (typeof toggleSettings === 'function') {
                toggleSettings(window.innerWidth > 768 ? shouldOpen : false);
            }
        } catch (_) {}

        // Cloudflare 代理开关
        const cfProxyToggle = document.getElementById('cf-proxy-toggle');
        if (cfProxyToggle) {
            cfProxyToggle.checked = ProxyManager && ProxyManager.isEnabled();
            cfProxyToggle.addEventListener('change', () => {
                ProxyManager && ProxyManager.setEnabled(cfProxyToggle.checked);
                showToast(cfProxyToggle.checked ? '已开启 Cloudflare 代理' : '已关闭 Cloudflare 代理', 'success', 1800);
                try { BananaTool.render(); } catch (_) {}
            });
        }

        // 同时生成图片数量（1-4）
        try {
            const savedCount = parseInt(localStorage.getItem('concurrent_image_count') || '1', 10);
            state.concurrentImageCount = [1, 2, 3, 4].includes(savedCount) ? savedCount : 1;
        } catch (_) {
            state.concurrentImageCount = 1;
        }
        document.querySelectorAll('#gen-count-selector .count-btn').forEach(btn => {
            const val = parseInt(btn.dataset.val || '1', 10);
            btn.classList.toggle('active', val === state.concurrentImageCount);
            btn.addEventListener('click', () => {
                const next = parseInt(btn.dataset.val || '1', 10);
                state.concurrentImageCount = [1, 2, 3, 4].includes(next) ? next : 1;
                try { localStorage.setItem('concurrent_image_count', String(state.concurrentImageCount)); } catch (_) {}
                document.querySelectorAll('#gen-count-selector .count-btn').forEach(b => {
                    const v = parseInt(b.dataset.val || '1', 10);
                    b.classList.toggle('active', v === state.concurrentImageCount);
                });
            }, { passive: true });
        });

        const streamToggle = document.getElementById('stream-toggle');
        if (streamToggle) {
            streamToggle.checked = localStorage.getItem('use_streaming') === 'true';
            state.useStreaming = streamToggle.checked;
            streamToggle.addEventListener('change', () => {
                state.useStreaming = streamToggle.checked;
                localStorage.setItem('use_streaming', streamToggle.checked);
            });
        }

        const contextToggle = document.getElementById('context-toggle');
        const contextCount = document.getElementById('context-count');
        if (contextToggle && contextCount) {
            contextToggle.checked = localStorage.getItem('use_context') === 'true';
            state.useContext = contextToggle.checked;
            state.contextCount = parseInt(localStorage.getItem('context_count') || '5', 10);
            contextCount.value = state.contextCount;
            contextToggle.addEventListener('change', () => {
                state.useContext = contextToggle.checked;
                localStorage.setItem('use_context', contextToggle.checked);
            });
            contextCount.addEventListener('change', () => {
                state.contextCount = parseInt(contextCount.value, 10);
                localStorage.setItem('context_count', contextCount.value);
            });
        }
    };

    function activateStickerMode(){createNewSession("表情包制作").then(()=>{const stickerPrompt="为我生成图中角色的绘制 Q 版的，LINE 风格的半身像表情包，注意头饰要正确\n彩色手绘风格，使用 4x6 布局，涵盖各种各样的常用聊天语句，或是一些有关的娱乐 meme\n其他需求：不要原图复制。所有标注为手写简体中文。";UI.textarea.value=stickerPrompt;state.resolution='4K';document.querySelectorAll('.res-btn').forEach(b=>b.classList.remove('active'));document.querySelector('.res-btn[data-val="4K"]').classList.add('active');state.aspectRatio='16:9';document.querySelectorAll('.ratio-card').forEach(c=>c.classList.remove('active'));document.querySelector('.ratio-card[data-val="16:9"]').classList.add('active');alert("已进入表情包模式！\n请点击输入框左侧图标上传一张角色参考图，然后点击发送。");adjustTextareaHeight();checkInput();if(window.innerWidth<=768)closeAllSidebars()})}
    
    async function renderSessionList(){const sessions=await getAllSessions();UI.sessionList.innerHTML='';sessions.forEach(s=>{const div=document.createElement('div');div.className=`session-item ${s.id===currentSessionId?'active':''}`;if(activeGenerations.has(s.id))div.classList.add('generating');div.innerHTML=`<div style="display:flex; align-items:center; overflow:hidden; width:100%;"><span class="session-loading">⏳</span><span style="overflow:hidden; text-overflow:ellipsis;">${escapeHtml(s.title)}</span></div><div class="session-delete" onclick="event.stopPropagation(); removeSession(${s.id})">×</div>`;div.onclick=()=>loadSession(s.id);UI.sessionList.appendChild(div)})}
    
    async function loadSession(sessionId){currentSessionId=sessionId;UI.chatHistory.innerHTML='';UI.emptyState.style.display='none';BlobManager.cleanup();renderSessionList();const messages=await getSessionMessages(sessionId);if(messages.length===0){UI.chatHistory.appendChild(UI.emptyState);UI.emptyState.style.display='flex'}else{messages.forEach(msg=>appendMessageToUI(msg.role,msg.rawHtml,msg.content,msg.images,msg.id));UI.chatHistory.scrollTop=UI.chatHistory.scrollHeight}if(activeGenerations.has(sessionId))appendMessageToUI('bot','<div class="loading-spinner" id="temp-loading" style="margin-left:20px;"></div>');if(window.innerWidth<=768)closeAllSidebars()}
    async function createNewSession(title="新对话"){const id=await createSession(title);await loadSession(id)}
    async function removeSession(id){if(!confirm('确定删除此对话？'))return;await deleteSession(id);if(id===currentSessionId){const sessions=await getAllSessions();if(sessions.length>0)await loadSession(sessions[0].id);else await createNewSession()}else{renderSessionList()}}

    // 清除全部对话
    async function clearAllSessions() {
        if (!confirm('确定要清除全部对话记录吗？此操作不可恢复！')) return;

        try {
            const sessions = await getAllSessions();

            // 删除所有对话
            for (const session of sessions) {
                await deleteSession(session.id);
            }

            // 创建新对话
            await createNewSession();

            showToast('✅ 已清除全部对话记录', 'success', 2000);
        } catch (error) {
            console.error('清除对话失败:', error);
            showToast('清除失败: ' + error.message, 'error');
        }
    }

    function useAsReference(base64){const mime="image/jpeg";const fullB64=base64.startsWith('data:')?base64:`data:${mime};base64,${base64}`;const rawBase64=fullB64.split(',')[1];state.images.push({base64:rawBase64,mimeType:mime,preview:base64ToBlobUrl(fullB64)});renderPreviews();checkInput();UI.textarea.focus();window.scrollTo(0,document.body.scrollHeight)}
    
    function appendMessageToUI(role, html, rawText = null, rawImages = [], messageId = null) {
        const div = document.createElement('div');
        div.className = `message-row ${role}`;
        if (messageId) div.setAttribute('data-message-id', messageId);
        let finalContentHtml = html;
        if (role === 'bot') {
            finalContentHtml = `<div style="display:flex; flex-direction:column; width:100%; align-items:flex-start;">${html}</div>`;
            // 为Bot消息添加操作按钮（只保留删除按钮）
            const botActionsHtml = `<div class="msg-actions" style="justify-content:flex-start;">${messageId ? `<div class="action-btn" onclick="handleDeleteMessage(${messageId})" style="color:#d93025"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg> 删除</div>` : ''}</div>`;
            finalContentHtml += botActionsHtml;
        }
        let finalHtml = `<div class="message-bubble-container">${finalContentHtml}</div>`;
        if (role === 'user') {
            if (rawImages && rawImages.length > 0) {
                let imgGridHtml = `<div style="display:flex; gap:5px; flex-wrap:wrap; justify-content:flex-end; margin-bottom:5px; width:100%">`;
                rawImages.forEach(imgData => {
                    let src = ''; if (typeof imgData === 'object' && imgData.preview) { src = imgData.preview; } else if (typeof imgData === 'string') { if (imgData.startsWith('data:')) src = imgData; else src = `data:image/jpeg;base64,${imgData}`; }
                    if(src) imgGridHtml += `<img src="${src}" class="generated-image" style="width:60px; height:60px; object-fit:cover; border-radius:8px;">`;
                });
                imgGridHtml += `</div>`; finalHtml = `<div style="display:flex; flex-direction:column; align-items:flex-end; width:100%">${imgGridHtml}${finalHtml}</div>`;
            }
            const escapedRawText = rawText ? escapeHtml(rawText) : '';
            let actionsHtml = `<div class="msg-actions"><div class="action-btn" onclick="copyText(this)" data-text="${escapedRawText}"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> 复制</div><div class="action-btn" onclick='handleEdit(${JSON.stringify(rawText||"")}, ${JSON.stringify(rawImages||[])})'><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg> 编辑</div><div class="action-btn" onclick='handleRegenerate(${JSON.stringify(rawText||"")}, ${JSON.stringify(rawImages||[])})'><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg> 重新生成</div>${messageId ? `<div class="action-btn" onclick="handleDeleteMessage(${messageId})" style="color:#d93025"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg> 删除</div>` : ''}</div>`;
            finalHtml += actionsHtml;
        }
        div.innerHTML = finalHtml; div.querySelectorAll('img.generated-image').forEach(img => img.onclick = () => openLightbox(img.src)); UI.chatHistory.appendChild(div); UI.chatHistory.scrollTop = UI.chatHistory.scrollHeight; return div;
    }

    function copyText(btn){navigator.clipboard.writeText(btn.getAttribute('data-text')).then(()=>{const original=btn.innerHTML;btn.innerHTML='<span>已复制</span>';setTimeout(()=>btn.innerHTML=original,1500)})}
    async function handleDeleteMessage(messageId){if(!confirm('确定要删除这条消息吗？'))return;await deleteMessage(messageId);const msgRow=document.querySelector(`[data-message-id="${messageId}"]`);if(msgRow)msgRow.remove();showToast('消息已删除','success')}
    function adjustTextareaHeight(){UI.textarea.style.height='auto';const maxHeight=150;const scrollHeight=UI.textarea.scrollHeight;if(scrollHeight>maxHeight){UI.textarea.style.height=maxHeight+'px';UI.textarea.style.overflowY='auto'}else{UI.textarea.style.height=scrollHeight+'px';UI.textarea.style.overflowY='hidden'}}
    function handleEdit(text,imagesBase64){ UI.textarea.value=text;state.images=[]; if(imagesBase64){ imagesBase64.forEach(b64=>{ const fullB64 = b64.startsWith('data:') ? b64 : `data:image/jpeg;base64,${b64}`; const raw = b64.startsWith('data:') ? b64.split(',')[1] : b64; state.images.push({base64:raw, mimeType:"image/jpeg", preview:base64ToBlobUrl(fullB64)}); }); } renderPreviews();checkInput();adjustTextareaHeight();UI.textarea.focus();UI.textarea.scrollTop=UI.textarea.scrollHeight }
    function handleRegenerate(text,imagesBase64){handleEdit(text,imagesBase64);sendMessage()}
    
    async function sendMessage(){
        if(!currentSessionId)await createNewSession();
        const text=UI.textarea.value.trim(); const hasImgs=state.images.length>0; if(!text&&!hasImgs)return;
        const config=ProviderManager.getConfig(); if(!config){alert("请先在右侧设置中添加 API 渠道");toggleSettings(true);return}

        // 清理可能残留的流式响应div
        const existingStreamDiv = document.getElementById('stream-text-content');
        if (existingStreamDiv && existingStreamDiv.closest('.message-row')) {
            existingStreamDiv.closest('.message-row').remove();
        }

        UI.emptyState.style.display='none';
        let userHtml = ""; if(text) userHtml+=`<div class="msg-content">${escapeHtml(text).replace(/\n/g,'<br>')}</div>`;
        const currentImagesBase64 = state.images.map(i => i.base64); const currentText = text; const thisSessionId = currentSessionId;
        UI.textarea.value=''; UI.textarea.style.height='24px'; state.images=[]; renderPreviews(); checkInput();
        const userMsgId = await saveMessage(thisSessionId, 'user', currentText, currentImagesBase64, userHtml);
        appendMessageToUI('user', userHtml, currentText, currentImagesBase64, userMsgId);
        const msgs = await getSessionMessages(thisSessionId); if(msgs.length<=1 && currentText){ const newTitle = currentText.substring(0, 20) + (currentText.length>20?'...':''); updateSessionTitle(thisSessionId, newTitle); renderSessionList(); }

         const batchCount = Math.min(4, Math.max(1, Number(state.concurrentImageCount || 1)));
         const useStreamingForThis = !!state.useStreaming && batchCount === 1;
         if (state.useStreaming && batchCount > 1) {
             showToast('多图并发已自动关闭流式传输', 'warning', 2500);
         }

         // 为每张图创建独立的 loading 消息（便于并发）
         const loadingDivs = [];
         const progressIds = [];
         const baseTs = Date.now();

         for (let i = 0; i < batchCount; i++) {
             const progressId = `progress-${baseTs}-${i + 1}`;
             progressIds.push(progressId);

             let loadingDiv = null;
             if (thisSessionId === currentSessionId) {
                 const badge = batchCount > 1
                     ? `<div style="margin: 0 0 6px 20px; font-size: 12px; color: #5f6368;">并发生成 ${i + 1}/${batchCount}</div>`
                     : '';
                 const loadingHtml = badge + SmartProgressBar.createHTML(progressId);
                 loadingDiv = appendMessageToUI('bot', loadingHtml);

                 const hasRefImages = currentImagesBase64.length > 0;
                 SmartProgressBar.start(progressId, state.resolution, hasRefImages);
             }
             loadingDivs.push(loadingDiv);
         }

         markGenerationStart(thisSessionId, batchCount);
         renderSessionList();

         for (let i = 0; i < batchCount; i++) {
             processGeneration(config, currentText, currentImagesBase64, loadingDivs[i], thisSessionId, progressIds[i], { useStreaming: useStreamingForThis, batchIndex: i + 1, batchTotal: batchCount });
         }
     }

    async function urlToRef(url) {
        try {
            const finalUrl = ProxyManager ? ProxyManager.getProxiedUrl(url) : url;
            const response = await nativeFetch(finalUrl);
            const blob = await response.blob();
            const reader = new FileReader();
            reader.onloadend = () => { useAsReference(reader.result); };
            reader.readAsDataURL(blob);
        } catch (e) {
            alert("获取远程图片失败（可能是跨域限制或网络屏蔽）。\n建议：部署到 Cloudflare Pages 并开启“Cloudflare 代理加载外部资源”。");
        }
    }

    async function processGeneration(config,text,imagesBase64,loadingDiv,sessionId,progressId,options={}){
        const useStreaming = typeof options.useStreaming === 'boolean' ? options.useStreaming : state.useStreaming;
        let ended = false;
        const endOnce = () => { if (ended) return; ended = true; markGenerationEnd(sessionId); renderSessionList(); };
        try{
            let data;
            if (config.type === 'openai') {
                // 构建消息数组
                let messages = [];
                let contextImages = []; // 收集上下文中的历史图片

                // 如果启用了上下文，获取历史消息
                if (state.useContext && state.contextCount > 0) {
                    const historyMessages = await getSessionMessages(sessionId);
                    // 获取最近N条消息（排除刚保存的当前用户消息）
                    const recentMessages = historyMessages.slice(-state.contextCount * 2 - 1, -1);

                    // 转换历史消息为API格式（OpenAI不支持历史图片在上下文中，只保留文本）
                    recentMessages.forEach(msg => {
                        const content = [];
                        if (msg.content) {
                            content.push({ type: "text", text: msg.content });
                        }
                        // 收集历史图片，但不放在历史消息中
                        if (msg.images && msg.images.length > 0) {
                            msg.images.forEach(b64 => {
                                contextImages.push(b64);
                            });
                        }
                        if (content.length > 0) {
                            messages.push({
                                role: msg.role === 'user' ? 'user' : 'assistant',
                                content: content
                            });
                        }
                    });
                }

                // 添加当前用户消息（包含历史图片和当前图片）
                const currentMessage = {
                    role: "user",
                    content: [{ type: "text", text: text || "Generate image" }]
                };
                // 先添加历史图片
                contextImages.forEach(b64 => {
                    currentMessage.content.push({
                        type: "image_url",
                        image_url: { url: `data:image/jpeg;base64,${b64}` }
                    });
                });
                // 再添加当前上传的图片
                imagesBase64.forEach(b64 => {
                    currentMessage.content.push({
                        type: "image_url",
                        image_url: { url: `data:image/jpeg;base64,${b64}` }
                    });
                });
                messages.push(currentMessage);

                let size = "1024x1024";
                if (state.resolution === "2K") size = "2048x2048";
                else if (state.resolution === "4K") size = "4096x4096";

                const payload = {
                    model: config.model,
                    messages: messages,
                    stream: useStreaming,
                    size: size,
                    aspect_ratio: state.aspectRatio !== 'auto' ? state.aspectRatio : undefined
                };

                // 构建请求 URL
                const requestUrl = `${config.host.replace(/\/$/,'')}/v1/chat/completions`;

                // 构建请求 headers
                const requestHeaders = {
                    'Authorization': `Bearer ${config.key}`,
                    'Content-Type': 'application/json'
                };

                const res = await nativeFetch(requestUrl, {
                    method: 'POST',
                    headers: requestHeaders,
                    body: JSON.stringify(payload)
                });
                
                if (!res.ok) {
                    const errorData = await res.json();
                    endOnce();
                    throw new Error(JSON.stringify(errorData));
                }
                
                if (useStreaming) {
                    data = await parseStreamResponse(res, loadingDiv, sessionId);
                } else {
                    data = await res.json();
                }
                
                endOnce();

                const streamTextDiv = data.streamTextDiv;
                
                if (data.choices?.[0]?.message?.content) {
                    const content = data.choices[0].message.content;
                    const dataUrlMatch = content.match(/!\[.*?\]\((data:image\/[^)]+)\)/);
                    const httpUrlMatch = content.match(/!\[.*?\]\((https?:\/\/[^)]+)\)/);
                    
                    let imageData = null;
                    let textContent = content;
                    
                    if (dataUrlMatch || httpUrlMatch) {
                        if (streamTextDiv && sessionId === currentSessionId) {
                            const contentEl = document.getElementById('stream-text-content');
                            if (contentEl) {
                                const currentText = contentEl.textContent.replace('[图片生成中...]', '');
                                if (currentText.trim()) {
                                    contentEl.innerHTML = escapeHtml(currentText) + '<div style="margin-top:12px;"><div class="loading-spinner" style="display:inline-block; margin-right:8px;"></div><span style="color:#666; font-size:12px;">正在加载图片...</span></div>';
                                } else {
                                    contentEl.innerHTML = '<div style="margin-top:12px;"><div class="loading-spinner" style="display:inline-block; margin-right:8px;"></div><span style="color:#666; font-size:12px;">正在加载图片...</span></div>';
                                }
                            }
                        }
                        
                        if (dataUrlMatch) {
                            imageData = dataUrlMatch[1].split(',')[1];
                            textContent = content.replace(/!\[.*?\]\((data:image\/[^)]+)\)/g, '').trim();
                        } else if (httpUrlMatch) {
                            const imageUrl = httpUrlMatch[1];
                            textContent = content.replace(/!\[.*?\]\((https?:\/\/[^)]+)\)/g, '').trim();
                            try {
                                const finalUrl = ProxyManager ? ProxyManager.getProxiedUrl(imageUrl) : imageUrl;
                                const imgRes = await nativeFetch(finalUrl);
                                const blob = await imgRes.blob();
                                imageData = await new Promise((resolve) => {
                                    const reader = new FileReader();
                                    reader.onloadend = () => resolve(reader.result.split(',')[1]);
                                    reader.readAsDataURL(blob);
                                });
                            } catch (e) {
                                console.error('Failed to fetch image from URL:', e);
                            }
                        }
                    }
                    
                    if (imageData) {
                        data = {
                            candidates: [{
                                content: {
                                    parts: [
                                        textContent ? { text: textContent } : null,
                                        {
                                            inlineData: {
                                                mimeType: 'image/jpeg',
                                                data: imageData
                                            }
                                        }
                                    ].filter(Boolean)
                                }
                            }]
                        };
                    } else if (streamTextDiv && sessionId === currentSessionId) {
                        const fullText = content.replace(/!\[.*?\]\((data:image\/[^)]+)\)/g, '').replace(/!\[.*?\]\((https?:\/\/[^)]+)\)/g, '').trim();
                        if(fullText) {
                            const finalHtml = `<div class="msg-content" style="padding:12px 18px; white-space:pre-wrap; line-height:1.6;">${escapeHtml(fullText)}</div>`;
                            streamTextDiv.querySelector('.msg-content').innerHTML = finalHtml.replace(/<div class="msg-content"[^>]*>|<\/div>$/g, '');
                            await saveMessage(sessionId,'bot',fullText,[],streamTextDiv.innerHTML);
                        } else {
                            streamTextDiv.remove();
                        }
                        return;
                    }
                }
            } else {
                // Build contents array for Gemini API
                let contents = [];
                let contextImages = []; // 收集上下文中的图片

                // If context enabled, get history messages
                if (state.useContext && state.contextCount > 0) {
                    const historyMessages = await getSessionMessages(sessionId);
                    const recentMessages = historyMessages.slice(-state.contextCount * 2 - 1, -1);
                    console.log('📖 读取历史消息，总数:', historyMessages.length, '使用:', recentMessages.length);

                    recentMessages.forEach(msg => {
                        const parts = [];
                        if (msg.content) {
                            parts.push({ text: msg.content });
                        }
                        // 收集历史图片，但不放在历史消息中
                        if (msg.images && msg.images.length > 0) {
                            console.log('📸 消息包含图片，数量:', msg.images.length, 'role:', msg.role);
                            msg.images.forEach(b64 => {
                                contextImages.push(b64); // 收集到contextImages数组
                            });
                        }
                        if (parts.length > 0) {
                            contents.push({
                                role: msg.role === 'user' ? 'user' : 'model',
                                parts: parts
                            });
                        }
                    });
                }

                // Add current message with all images (context + current)
                const currentParts = text ? [{ text }] : [{ text: "Generate image" }];
                // 先添加上下文中的历史图片
                contextImages.forEach(b64 => {
                    currentParts.push({ inline_data: { mime_type: 'image/jpeg', data: b64 } });
                });
                // 再添加当前上传的图片
                imagesBase64.forEach(b64 => {
                    currentParts.push({ inline_data: { mime_type: 'image/jpeg', data: b64 } });
                });
                contents.push({ role: "user", parts: currentParts });

                const generationConfig = { responseModalities: ["TEXT", "IMAGE"], imageConfig: { imageSize: state.resolution } };
                if (state.aspectRatio && state.aspectRatio !== 'auto') generationConfig.imageConfig.aspectRatio = state.aspectRatio;
                const payload = { contents: contents, generationConfig: generationConfig };

                // 构建请求 URL
                const requestUrl = `${config.host.replace(/\/$/,'')}/v1beta/models/${config.model}:generateContent`;

                // 构建请求 headers
                const requestHeaders = {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': config.key
                };

                const res = await nativeFetch(requestUrl, {
                    method: 'POST',
                    headers: requestHeaders,
                    body: JSON.stringify(payload)
                });
                data = await res.json();
                endOnce();
                if (!res.ok) throw new Error(JSON.stringify(data));
            }
            const streamTextDiv = data.streamTextDiv;

            let botInnerHtml='';
            let generatedImages = []; // 收集生成的图片base64数据
            if(data.candidates?.[0]?.content?.parts){
                data.candidates[0].content.parts.forEach(part=>{
                    if(part.inlineData&&part.inlineData.mimeType.startsWith('image/')){
                        const fullBase64=`data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
                        generatedImages.push(part.inlineData.data); // 保存纯base64数据
                        console.log('🎨 收集到生成的图片，base64长度:', part.inlineData.data.length);
                        const now=new Date();
                        const filename=`gemini_${now.getTime()}.png`;

                        // 自动保存到本地目录
                        if (FileSystemManager.isEnabled && FileSystemManager.directoryHandle) {
                            console.log('🎨 图片生成完成，开始自动保存...');
                            FileSystemManager.saveImageToDirectory(fullBase64, filename).then(success => {
                                if (success) {
                                    console.log('✅ 图片已自动保存到本地目录');
                                    showToast(`✅ 图片已保存: ${filename}`, 'success', 2000);
                                }
                            });
                        }

                        botInnerHtml+=`<div class="msg-content" style="padding:0"><div class="img-result-group"><img class="generated-image" src="${fullBase64}" data-filename="${filename}"><div class="btn-group"><div class="tool-btn download" onclick='downloadImage("${fullBase64}", "${filename}")'><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> 下载原图</div><div class="tool-btn" onclick='useAsReference("${fullBase64}")'><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> 设为参考图</div><div class="tool-btn slice-btn" onclick='SlicerTool.open("${fullBase64}")'><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3L6 21"/><path d="M18 3L18 21"/><path d="M2 12L22 12"/></svg> 切割/表情包</div></div></div></div>`;
                    } else if(part.text){
                        let textContent = part.text;
                        let imagesHtml = '';
                        const imgRegex = /!\[([^\]]*)\]\(((?:https?:|data:image\/)[^)]+)\)/g;
                        let match;

                        while ((match = imgRegex.exec(textContent)) !== null) {
                            const url = match[2];
                            const filename = `image_${Date.now()}_${Math.floor(Math.random()*1000)}.png`;
                            const safeUrl = ProxyManager ? ProxyManager.getProxiedUrl(url) : url;
                            const isBase64 = safeUrl.startsWith('data:');

                            // 提取base64数据并保存
                            if (isBase64) {
                                const base64Data = safeUrl.split(',')[1]; // 提取纯base64部分
                                if (base64Data) {
                                    generatedImages.push(base64Data);
                                    console.log('🎨 收集到Markdown图片，base64长度:', base64Data.length);
                                }
                            }

                            // 自动保存到本地目录（仅 base64 图片）
                            if (isBase64 && FileSystemManager.isEnabled && FileSystemManager.directoryHandle) {
                                console.log('🎨 Markdown 图片生成完成，开始自动保存...');
                                FileSystemManager.saveImageToDirectory(safeUrl, filename).then(success => {
                                    if (success) {
                                        console.log('✅ Markdown 图片已自动保存到本地目录');
                                        showToast(`✅ 图片已保存: ${filename}`, 'success', 2000);
                                    }
                                });
                            }

                            const refAction = isBase64 ? `useAsReference("${safeUrl}")` : `urlToRef("${safeUrl}")`;
                            imagesHtml += `<div class="msg-content" style="padding:0"><div class="img-result-group"><img class="generated-image" src="${safeUrl}" crossorigin="anonymous" onerror="this.onerror=null;this.src='${safeUrl}';"><div class="btn-group"><a class="tool-btn download" href="${safeUrl}" target="_blank" download="${filename}"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> 打开/下载</a><div class="tool-btn" onclick='${refAction}'><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> 设为参考图</div><div class="tool-btn slice-btn" onclick='SlicerTool.open("${safeUrl}")'><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3L6 21"/><path d="M18 3L18 21"/><path d="M2 12L22 12"/></svg> 切割/表情包</div></div></div></div>`;
                        }

                        textContent = textContent.replace(imgRegex, '');
                        if (textContent.trim()) {
                            botInnerHtml += `<div class="msg-content" style="padding:0; width:100%"><details class="thought-box"><summary>Thinking / Output</summary><div class="thought-content">${escapeHtml(textContent)}</div></details></div>`;
                        }
                        botInnerHtml += imagesHtml;
                    }
                })
            }

            if(botInnerHtml){
                if(streamTextDiv && sessionId===currentSessionId) {
                    const contentEl = document.getElementById('stream-text-content');
                    if(contentEl) {
                        const textContent = contentEl.textContent || data.choices?.[0]?.message?.content || '';
                        const cleanText = textContent.replace(/正在加载图片\.\.\./g, '').replace(/\[图片生成中\.\.\.\]/g, '').trim();
                        if(cleanText) {
                            const textHtml = `<div class="msg-content" style="padding:12px 18px; white-space:pre-wrap; line-height:1.6;">${escapeHtml(cleanText)}</div>`;
                            const combinedHtml = textHtml + botInnerHtml;
                            streamTextDiv.remove();
                            console.log('💾 保存bot消息（文本+图片），图片数量:', generatedImages.length);
                            const botMsgId = await saveMessage(sessionId,'bot','Text and Image',generatedImages,combinedHtml);
                            if(sessionId===currentSessionId){
                                // 完成进度条
                                if(progressId) {
                                    SmartProgressBar.complete(progressId, () => {
                                        if(loadingDiv) loadingDiv.remove();
                                    });
                                } else {
                                    if(loadingDiv) loadingDiv.remove();
                                }
                                const tempLoading=document.getElementById('temp-loading');
                                if(tempLoading)tempLoading.parentElement.remove();

                                // 清理所有可能残留的流式响应div
                                const streamDiv = document.getElementById('stream-text-content');
                                if (streamDiv && streamDiv.closest('.message-row')) {
                                    streamDiv.closest('.message-row').remove();
                                }

                                appendMessageToUI('bot',combinedHtml,'Text and Image',[],botMsgId);
                            }
                            return;
                        }
                    }
                    streamTextDiv.remove();
                }
                console.log('💾 保存bot消息（仅图片），图片数量:', generatedImages.length);
                const botMsgId = await saveMessage(sessionId,'bot','Image Generated',generatedImages,botInnerHtml);
                if(sessionId===currentSessionId){
                    // 完成进度条
                    if(progressId) {
                        SmartProgressBar.complete(progressId, () => {
                            if(loadingDiv) loadingDiv.remove();
                        });
                    } else {
                        if(loadingDiv) loadingDiv.remove();
                    }
                    const tempLoading=document.getElementById('temp-loading');
                    if(tempLoading)tempLoading.parentElement.remove();
                    const loadingSpinners = document.querySelectorAll('.loading-spinner');
                    loadingSpinners.forEach(spinner => {
                        if(spinner.parentElement && spinner.parentElement.textContent.includes('正在加载图片')) {
                            spinner.parentElement.remove();
                        }
                    });

                    // 清理所有可能残留的流式响应div
                    const streamDiv = document.getElementById('stream-text-content');
                    if (streamDiv && streamDiv.closest('.message-row')) {
                        streamDiv.closest('.message-row').remove();
                    }

                    appendMessageToUI('bot',botInnerHtml,'Image Generated',[],botMsgId);
                }
            }

            // 兜底清理：如果streamTextDiv还存在，删除它
            if(streamTextDiv && sessionId===currentSessionId) {
                streamTextDiv.remove();
            }

        }catch(e){
            // 停止进度条
            if(progressId) SmartProgressBar.stop(progressId);

            // 清理可能残留的流式响应div
            const streamDiv = document.getElementById('stream-text-content');
            if (streamDiv && streamDiv.closest('.message-row')) {
                streamDiv.closest('.message-row').remove();
            }

            endOnce(); let msg=e.message; try{const jsonErr=JSON.parse(e.message);if(jsonErr.error&&jsonErr.error.message)msg=jsonErr.error.message}catch(_){} const errorHtml=`<div class="msg-content" style="color:#d93025">❌ Error: ${escapeHtml(msg)}</div>`; const errorMsgId = await saveMessage(sessionId,'bot','Error',[],errorHtml); if(sessionId===currentSessionId){ if(loadingDiv)loadingDiv.remove(); appendMessageToUI('bot',errorHtml,'Error',[],errorMsgId) }
        }
    }

    async function parseStreamResponse(response, loadingDiv, sessionId) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullContent = '';
        let textMessageDiv = null;
        
        const existingStreamDiv = document.getElementById('stream-text-content');
        if (existingStreamDiv && existingStreamDiv.closest('.message-row')) {
            existingStreamDiv.closest('.message-row').remove();
        }
        
        while (true) {
            const {done, value} = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, {stream: true});
            const lines = buffer.split('\n');
            buffer = lines.pop();
            
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6).trim();
                    if (data === '[DONE]') continue;
                    
                    try {
                        const json = JSON.parse(data);
                        if (json.choices?.[0]?.delta?.content) {
                            const chunk = json.choices[0].delta.content;
                            fullContent += chunk;
                            
                            if (sessionId === currentSessionId) {
                                const displayContent = fullContent.replace(/!\[.*?\]\((data:image\/[^)]+)\)/g, '[图片生成中...]').replace(/!\[.*?\]\((https?:\/\/[^)]+)\)/g, '[图片生成中...]');
                                
                                if (!textMessageDiv && displayContent.trim() && !displayContent.match(/^data:image\//)) {
                                    if (loadingDiv) loadingDiv.remove();
                                    const textHtml = '<div class="msg-content" style="padding:12px 18px; white-space:pre-wrap; font-family:monospace; font-size:13px; line-height:1.6;"><div id="stream-text-content"></div></div>';
                                    textMessageDiv = appendMessageToUI('bot', textHtml);
                                }
                                const contentEl = document.getElementById('stream-text-content');
                                if (contentEl && displayContent.trim()) {
                                    contentEl.textContent = displayContent;
                                    UI.chatHistory.scrollTop = UI.chatHistory.scrollHeight;
                                }
                            }
                        }
                    } catch (e) {
                        console.warn('Parse SSE error:', e);
                    }
                }
            }
        }

        // 流式响应结束后，检查是否有内容，如果没有就删除空div
        if (textMessageDiv && !fullContent.trim()) {
            textMessageDiv.remove();
            textMessageDiv = null;
        }

        return {
            choices: [{
                message: {
                    content: fullContent
                }
            }],
            streamTextDiv: textMessageDiv
        };
    }
    
    function base64ToBlobUrl(base64Data){try{const arr=base64Data.split(',');const mime=arr[0].match(/:(.*?);/)[1];const bstr=atob(arr[1]);let n=bstr.length;const u8arr=new Uint8Array(n);while(n--){u8arr[n]=bstr.charCodeAt(n)}return BlobManager.create(new Blob([u8arr],{type:mime}))}catch(e){console.error(e);return''}}
    
    function downloadImage(base64Data, filename) {
        console.log('📥 downloadImage 被调用');
        console.log('  - filename:', filename);
        console.log('  - FileSystemManager.isEnabled:', FileSystemManager.isEnabled);
        console.log('  - FileSystemManager.directoryHandle:', FileSystemManager.directoryHandle);

        // 优先尝试自动保存到本地目录
        if (FileSystemManager.isEnabled && FileSystemManager.directoryHandle) {
            console.log('✅ 满足自动保存条件，开始保存...');
            FileSystemManager.saveImageToDirectory(base64Data, filename).then(success => {
                if (success) {
                    console.log('✅ 自动保存成功！');
                    showToast('图片已保存到本地目录 ✓', 'success');
                    return;
                }
                console.log('⚠️ 自动保存失败，使用下载方式');
                // 如果保存失败，继续使用下载方式
                proceedWithDownload();
            });
            return;
        }

        console.log('ℹ️ 使用传统下载方式');
        // 使用原有的下载方式
        proceedWithDownload();

        function proceedWithDownload() {
            const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
            const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
            const isLocalFile = window.location.protocol === 'file:';
        
        if (isIOS || isSafari || isLocalFile) {
            const newWindow = window.open();
            if (newWindow) {
                const tipText = isLocalFile 
                    ? '<strong>💾 本地文件模式</strong>右键图片 → 另存为<br><small>或使用 HTTP 服务器运行以支持直接下载</small>'
                    : '<strong>📱 保存方法</strong>长按图片 → 选择"存储图像"';
                
                newWindow.document.write(`
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                        <title>${filename}</title>
                        <style>
                            body { margin: 0; padding: 20px; background: #000; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; }
                            img { max-width: 100%; height: auto; border-radius: 8px; box-shadow: 0 4px 20px rgba(255,255,255,0.1); }
                            .tip { color: #fff; margin-top: 20px; text-align: center; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 14px; line-height: 1.6; }
                            .tip strong { display: block; margin-bottom: 8px; font-size: 16px; }
                            .tip small { display: block; margin-top: 8px; opacity: 0.7; font-size: 12px; }
                        </style>
                    </head>
                    <body>
                        <img src="${base64Data}" alt="${filename}">
                        <div class="tip">${tipText}</div>
                    </body>
                    </html>
                `);
                newWindow.document.close();
            } else {
                showToast('请允许弹出窗口以查看图片', 'warning', 3000);
            }
        } else {
            try {
                const link = document.createElement('a');
                link.href = base64Data;
                link.download = filename;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                showToast('下载成功', 'success');
            } catch (e) {
                console.error('Download failed:', e);
                const newWindow = window.open();
                if (newWindow) {
                    newWindow.document.write(`
                        <!DOCTYPE html>
                        <html>
                        <head>
                            <meta name="viewport" content="width=device-width, initial-scale=1.0">
                            <title>${filename}</title>
                            <style>
                                body { margin: 0; padding: 20px; background: #000; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; }
                                img { max-width: 100%; height: auto; border-radius: 8px; }
                                .tip { color: #fff; margin-top: 20px; text-align: center; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 14px; line-height: 1.6; }
                                .tip strong { display: block; margin-bottom: 8px; font-size: 16px; color: #ff6b6b; }
                            </style>
                        </head>
                        <body>
                            <img src="${base64Data}" alt="${filename}">
                            <div class="tip">
                                <strong>⚠️ 下载失败</strong>
                                请右键图片选择"另存为"
                            </div>
                        </body>
                        </html>
                    `);
                    newWindow.document.close();
                } else {
                    showToast('下载失败，请右键图片另存为', 'error', 3000);
                }
            }
        }
        } // 关闭 proceedWithDownload 函数
    }
    
    const LightboxController=(()=>{
        let inited=false; let el=null; let img=null;
        let scale=1; let tx=0; let ty=0;
        const pointers=new Map(); let gesture=null;
        const MIN_SCALE=1; const MAX_SCALE=6;

        const isActive=()=>el&&el.classList.contains('active');
        const clampScale=(s)=>Math.max(MIN_SCALE,Math.min(MAX_SCALE,s));
        const apply=()=>{
            if(!el||!img) return;
            img.style.transform=`translate(${tx}px, ${ty}px) scale(${scale})`;
            el.classList.toggle('zoomed',scale>1.01);
            img.style.cursor=scale>1.01?'grab':'zoom-in';
        };
        const reset=()=>{scale=1; tx=0; ty=0; gesture=null; pointers.clear(); apply();};

        const zoomTo=(nextScale,cx,cy)=>{
            if(!img) return;
            const oldRect=img.getBoundingClientRect();
            if(!oldRect.width||!oldRect.height){
                scale=clampScale(nextScale);
                if(scale===1){tx=0; ty=0;}
                apply();
                return;
            }
            const relX=(cx-oldRect.left)/oldRect.width;
            const relY=(cy-oldRect.top)/oldRect.height;
            const prevScale=scale;
            scale=clampScale(nextScale);
            if(Math.abs(scale-prevScale)<0.001) return;

            apply();

            const newRect=img.getBoundingClientRect();
            if(newRect.width&&newRect.height){
                const targetLeft=cx-relX*newRect.width;
                const targetTop=cy-relY*newRect.height;
                tx+=targetLeft-newRect.left;
                ty+=targetTop-newRect.top;
            }
            if(scale===1){tx=0; ty=0;}
            apply();
        };

        const onWheel=(e)=>{
            if(!isActive()) return;
            e.preventDefault();
            const factor=Math.exp(-(e.deltaY||0)*0.002);
            zoomTo(scale*factor,e.clientX,e.clientY);
        };

        const updateFromPointers=()=>{
            if(!isActive()) return;
            if(pointers.size===1){
                const p=Array.from(pointers.values())[0];
                if(!gesture||gesture.type!=='pan'){gesture={type:'pan',lastX:p.x,lastY:p.y};return;}
                const dx=p.x-gesture.lastX; const dy=p.y-gesture.lastY;
                tx+=dx; ty+=dy;
                gesture.lastX=p.x; gesture.lastY=p.y;
                apply();
                return;
            }
            if(pointers.size>=2){
                const arr=Array.from(pointers.values());
                const p1=arr[0]; const p2=arr[1];
                const midX=(p1.x+p2.x)/2; const midY=(p1.y+p2.y)/2;
                const dist=Math.hypot(p1.x-p2.x,p1.y-p2.y);
                if(!gesture||gesture.type!=='pinch'){gesture={type:'pinch',lastDist:dist,lastMidX:midX,lastMidY:midY};return;}

                const panDx=midX-gesture.lastMidX; const panDy=midY-gesture.lastMidY;
                tx+=panDx; ty+=panDy;
                gesture.lastMidX=midX; gesture.lastMidY=midY;

                if(gesture.lastDist>0&&dist>0){
                    const factor=dist/gesture.lastDist;
                    gesture.lastDist=dist;
                    zoomTo(scale*factor,midX,midY);
                } else {
                    gesture.lastDist=dist;
                    apply();
                }
            }
        };

        const onPointerDown=(e)=>{
            if(!isActive()||!img) return;
            if(e.button!==undefined&&e.button!==0) return;
            e.preventDefault();
            img.setPointerCapture?.(e.pointerId);
            pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
            img.style.cursor='grabbing';
            gesture=null;
            updateFromPointers();
        };
        const onPointerMove=(e)=>{
            if(!isActive()) return;
            if(!pointers.has(e.pointerId)) return;
            e.preventDefault();
            pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
            updateFromPointers();
        };
        const onPointerUp=(e)=>{
            if(!isActive()) return;
            pointers.delete(e.pointerId);
            gesture=null;
            if(pointers.size===0){ if(img) img.style.cursor=scale>1.01?'grab':'zoom-in'; return; }
            updateFromPointers();
        };
        const onDblClick=(e)=>{
            if(!isActive()) return;
            e.preventDefault();
            if(scale>1.01) reset();
            else zoomTo(2,e.clientX,e.clientY);
        };

        const init=()=>{
            if(inited) return;
            el=document.getElementById('lightbox');
            img=document.getElementById('lightbox-image');
            if(!el||!img) return;
            inited=true;
            el.addEventListener('wheel',onWheel,{passive:false});
            img.addEventListener('pointerdown',onPointerDown);
            img.addEventListener('pointermove',onPointerMove);
            img.addEventListener('pointerup',onPointerUp);
            img.addEventListener('pointercancel',onPointerUp);
            img.addEventListener('dblclick',onDblClick);
        };

        const open=(src)=>{
            init();
            if(!el||!img) return;
            img.src=src||'';
            el.classList.add('active');
            reset();
        };
        const close=()=>{
            if(!el||!img) return;
            el.classList.remove('active');
            el.classList.remove('zoomed');
            reset();
            setTimeout(()=>{if(img) img.src='';},200);
        };
        return {open,close};
    })();

    function openLightbox(src){LightboxController.open(ProxyManager ? ProxyManager.getProxiedUrl(src) : src)}
    function closeLightbox(){LightboxController.close()}

    // 提示词卡片图片加载失败时的兜底：优先回退直连，再回退占位图（可被代理）
    function handlePromptImageError(imgEl){
        try{
            if(!imgEl) return;
            const triedRaw = imgEl.getAttribute('data-tried-raw') === '1';
            const raw = imgEl.getAttribute('data-raw-src') || '';
            const placeholder = imgEl.getAttribute('data-placeholder-src') || '';
            const current = imgEl.getAttribute('src') || '';

            if(!triedRaw && raw && current !== raw){
                imgEl.setAttribute('data-tried-raw','1');
                imgEl.src = raw;
                return;
            }

            if(placeholder && current !== placeholder){
                imgEl.src = placeholder;
            }
        }catch(_){}
    }
    const leftSidebar=document.getElementById('left-sidebar');const rightSidebar=document.getElementById('right-sidebar');const overlay=document.getElementById('overlay');
    const SIDEBAR_OVERLAY_MAX_WIDTH = 768;
    function isSidebarOverlayMode(){return window.innerWidth<=SIDEBAR_OVERLAY_MAX_WIDTH}
    function updateSettingsPinnedLayout(){if(!rightSidebar) return;const open=rightSidebar.classList.contains('open');document.body.classList.toggle('settings-open',!!open&&!isSidebarOverlayMode())}
    function syncOverlay(){if(!overlay)return;if(!isSidebarOverlayMode()){overlay.classList.remove('active');return}const anyOpen=(leftSidebar&&leftSidebar.classList.contains('open'))||(rightSidebar&&rightSidebar.classList.contains('open'));overlay.classList.toggle('active',!!anyOpen)}
    function toggleLeftSidebar(forceOpen){if(!leftSidebar)return;const next=typeof forceOpen==='boolean'?forceOpen:!leftSidebar.classList.contains('open');leftSidebar.classList.toggle('open',next);if(isSidebarOverlayMode()&&rightSidebar)rightSidebar.classList.remove('open');updateSettingsPinnedLayout();syncOverlay()}
    function toggleSettings(forceOpen){if(!rightSidebar)return;const next=typeof forceOpen==='boolean'?forceOpen:!rightSidebar.classList.contains('open');rightSidebar.classList.toggle('open',next);try{localStorage.setItem('settings_open',String(!!next))}catch(_){}if(isSidebarOverlayMode()&&leftSidebar)leftSidebar.classList.remove('open');updateSettingsPinnedLayout();syncOverlay()}
    function closeAllSidebars(){if(isSidebarOverlayMode()){if(leftSidebar)leftSidebar.classList.remove('open');if(rightSidebar)rightSidebar.classList.remove('open')}updateSettingsPinnedLayout();syncOverlay()}
    window.addEventListener('resize',()=>{updateSettingsPinnedLayout();syncOverlay()});
    UI.textarea.addEventListener('input',function(){adjustTextareaHeight();checkInput()});
    UI.textarea.addEventListener('keydown',(e)=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage()}});
    
    // 粘贴图片支持
    UI.textarea.addEventListener('paste', async (e) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        
        for (let item of items) {
            if (item.type.startsWith('image/')) {
                e.preventDefault();
                const file = item.getAsFile();
                if (file) {
                    await handleFiles([file]);
                    showToast('已粘贴图片', 'success');
                }
            }
        }
    });
    
    // 拖拽图片支持
    const inputWrapper = document.querySelector('.input-wrapper');
    const inputContainerOuter = document.querySelector('.input-container-outer');
    
    // 为输入框容器添加拖拽支持
    [inputWrapper, inputContainerOuter].forEach(element => {
        if (!element) return;
        
        element.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            inputWrapper.classList.add('drag-over');
        });
        
        element.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            // 只有当离开整个容器时才移除样式
            if (!inputWrapper.contains(e.relatedTarget)) {
                inputWrapper.classList.remove('drag-over');
            }
        });
        
        element.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            inputWrapper.classList.remove('drag-over');
            
            const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
            if (files.length > 0) {
                await handleFiles(files);
                showToast(`已添加 ${files.length} 张图片`, 'success');
            } else if (e.dataTransfer.files.length > 0) {
                showToast('请拖拽图片文件', 'warning');
            }
        });
    });
    
    // 为整个聊天区域添加拖拽支持
    const chatContainer = document.querySelector('.chat-container');
    if (chatContainer) {
        chatContainer.addEventListener('dragover', (e) => {
            const files = Array.from(e.dataTransfer.items).filter(item => item.kind === 'file' && item.type.startsWith('image/'));
            if (files.length > 0) {
                e.preventDefault();
                e.stopPropagation();
                inputWrapper.classList.add('drag-over');
            }
        });
        
        chatContainer.addEventListener('drop', async (e) => {
            const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
            if (files.length > 0) {
                e.preventDefault();
                e.stopPropagation();
                inputWrapper.classList.remove('drag-over');
                await handleFiles(files);
                showToast(`已添加 ${files.length} 张图片`, 'success');
            }
        });
    }
    
    function checkInput(){if(UI.textarea.value.trim().length>0||state.images.length>0)UI.sendBtn.classList.add('active');else UI.sendBtn.classList.remove('active')}
    document.querySelectorAll('.res-btn').forEach(btn=>btn.addEventListener('click',()=>{document.querySelectorAll('.res-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');state.resolution=btn.dataset.val}));document.querySelectorAll('.ratio-card').forEach(card=>card.addEventListener('click',()=>{document.querySelectorAll('.ratio-card').forEach(c=>c.classList.remove('active'));card.classList.add('active');state.aspectRatio=card.dataset.val}));
    async function handleFiles(files){if(state.images.length+files.length>14){alert("最多14张");return}for(let file of files){if(!file.type.startsWith('image/'))continue;state.images.push(await compressImage(file))}renderPreviews();checkInput();UI.fileInput.value=''}
    function compressImage(file){return new Promise((resolve)=>{const reader=new FileReader();reader.readAsDataURL(file);reader.onload=(e)=>{const img=new Image();img.src=e.target.result;img.onload=()=>{let w=img.width,h=img.height,max=1536;if(file.size<1024*1024&&w<max&&h<max){resolve({base64:e.target.result.split(',')[1],mimeType:file.type,preview:e.target.result});return}if(w>h){if(w>max){h*=max/w;w=max}}else{if(h>max){w*=max/h;h=max}}const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;canvas.getContext('2d').drawImage(img,0,0,w,h);const dataUrl=canvas.toDataURL('image/jpeg',0.85);resolve({base64:dataUrl.split(',')[1],mimeType:'image/jpeg',preview:dataUrl})}}})}
    function renderPreviews(){UI.previewArea.innerHTML='';if(state.images.length>0){UI.previewArea.classList.add('has-images');state.images.forEach((img,i)=>{const div=document.createElement('div');div.className='preview-item';div.style.backgroundImage=`url(${img.preview})`;div.innerHTML=`<div class="preview-close" onclick="state.images.splice(${i},1);renderPreviews();checkInput()">×</div>`;UI.previewArea.appendChild(div)})}else UI.previewArea.classList.remove('has-images')}
