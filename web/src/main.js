// 主应用组件 - GitHub仓库监控器
export default {
  name: 'MainApp',
  setup() {
    const { ref, computed, onMounted } = Vue;
    
    // 基础状态
    const repositories = ref([]);
    const isLoading = ref(true);
    const error = ref(null);
    const lastUpdateTime = ref('');
    
    // 性能优化状态
    const pageSize = ref(10); // 每页显示数量，默认10条
    const currentPage = ref(1);
    const customPageSize = ref(10); // 自定义页面大小输入
    const searchDebounceTimer = ref(null);
    const virtualScrollContainer = ref(null);
    const tableHeight = ref(600); // 表格高度
    const itemHeight = ref(60); // 每行高度
    
    // 搜索和过滤
    const searchQuery = ref('');
    const searchQueryDebounced = ref('');
    const sortBy = ref('last_update');
    const showErrorsOnly = ref(false);
    const timeFilter = ref('');
    
    // 选择状态
    const selectedRepos = ref([]);
    const selectAll = ref(false);
    
    // 表单输入
    const newRepoName = ref('');
    
    // 添加模式状态
    const importMode = ref('single'); // 'single' 或 'batch'
    const batchImportText = ref('');
    
    // 模态框状态
    const showConfigModal = ref(false);
    const showStatusPanel = ref(false); // 系统状态面板默认隐藏
    const showAddRepoArea = ref(true); // 控制添加仓库区域显示
    
    // 导入功能状态
    const isImporting = ref(false);
    const importProgress = ref({ current: 0, total: 0 });
    const importStats = ref({ total: 0, success: 0, failed: 0, duplicates: 0 });
    const importResults = ref([]);
    const importStatus = ref('');
    const importPaused = ref(false);
    const importCancelled = ref(false);
    const importOptions = ref({
      skipExisting: true,
      continueOnError: true
    });
    
    // 预设仓库列表
    const presetRepos = {
      frontend: [
        'facebook/react', 'vuejs/vue', 'angular/angular', 'sveltejs/svelte',
        'microsoft/TypeScript', 'webpack/webpack', 'vitejs/vite', 'parcel-bundler/parcel'
      ],
      backend: [
        'nodejs/node', 'expressjs/express', 'nestjs/nest', 'koajs/koa',
        'golang/go', 'gin-gonic/gin', 'spring-projects/spring-boot', 'django/django'
      ],
      devtools: [
        'microsoft/vscode', 'atom/atom', 'git/git', 'docker/docker-ce',
        'kubernetes/kubernetes', 'grafana/grafana', 'prometheus/prometheus'
      ],
      ai: [
        'tensorflow/tensorflow', 'pytorch/pytorch', 'huggingface/transformers',
        'openai/openai-python', 'microsoft/DeepSpeed', 'facebookresearch/detectron2'
      ],
      mobile: [
        'facebook/react-native', 'flutter/flutter', 'ionic-team/ionic-framework',
        'apache/cordova-android', 'xamarin/Xamarin.Forms'
      ]
    };
    
    // 配置状态
    const config = ref({
      githubToken: '',
      hasToken: false,
      updateInterval: 10,
      initialDelay: 30,
      maxConcurrentRequests: 3,
      requestDelay: 1000
    });
    
    // 队列和GitHub状态
    const queueStatus = ref({});
    const githubStatus = ref({});
    const checkingRepos = ref([]);
    const checkingAll = ref(false);

    // 防抖搜索
    const debouncedSearch = (query) => {
      if (searchDebounceTimer.value) {
        clearTimeout(searchDebounceTimer.value);
      }
      searchDebounceTimer.value = setTimeout(() => {
        searchQueryDebounced.value = query;
      }, 300); // 300ms 防抖延迟
    };

    // 监听搜索变化，实现防抖
    Vue.watch(searchQuery, (newQuery) => {
      debouncedSearch(newQuery);
    });

    // 计算属性 - 过滤后的仓库列表（使用防抖搜索）
    const filteredRepositories = computed(() => {
      let filtered = repositories.value;

      // 搜索过滤（使用防抖后的查询）
      if (searchQueryDebounced.value) {
        const query = searchQueryDebounced.value.toLowerCase();
        filtered = filtered.filter(repo => 
          repo.name.toLowerCase().includes(query) ||
          repo.committer?.toLowerCase().includes(query) ||
          repo.commit_message?.toLowerCase().includes(query)
        );
      }

      // 错误过滤
      if (showErrorsOnly.value) {
        filtered = filtered.filter(repo => repo.status === 'error');
      }

      // 时间过滤
      if (timeFilter.value) {
        const now = new Date();
        let cutoffTime;
        
        switch (timeFilter.value) {
          case '1h':
            cutoffTime = new Date(now - 60 * 60 * 1000);
            break;
          case '24h':
            cutoffTime = new Date(now - 24 * 60 * 60 * 1000);
            break;
          case '7d':
            cutoffTime = new Date(now - 7 * 24 * 60 * 60 * 1000);
            break;
          case '30d':
            cutoffTime = new Date(now - 30 * 24 * 60 * 60 * 1000);
            break;
        }
        
        if (cutoffTime) {
          filtered = filtered.filter(repo => new Date(repo.last_update) >= cutoffTime);
        }
      }

      // 排序
      filtered.sort((a, b) => {
        switch (sortBy.value) {
          case 'name':
            return a.name.localeCompare(b.name);
          case 'last_update':
            return new Date(b.last_update) - new Date(a.last_update);
          default:
            return 0;
        }
      });

      return filtered;
    });

    // 分页计算属性
    const totalPages = computed(() => {
      const size = pageSize.value === 'custom' ? customPageSize.value : parseInt(pageSize.value);
      return Math.ceil(filteredRepositories.value.length / size);
    });

    // 当前页显示的仓库列表（分页）
    const paginatedRepositories = computed(() => {
      const size = pageSize.value === 'custom' ? customPageSize.value : parseInt(pageSize.value);
      const start = (currentPage.value - 1) * size;
      const end = start + size;
      return filteredRepositories.value.slice(start, end);
    });

    // 虚拟滚动计算属性
    const virtualScrollData = computed(() => {
      const total = filteredRepositories.value.length;
      const containerHeight = tableHeight.value;
      const rowHeight = itemHeight.value;
      const visibleCount = Math.ceil(containerHeight / rowHeight);
      const scrollTop = virtualScrollContainer.value?.scrollTop || 0;
      const startIndex = Math.floor(scrollTop / rowHeight);
      const endIndex = Math.min(startIndex + visibleCount + 2, total); // +2 作为缓冲
      
      return {
        total,
        startIndex,
        endIndex,
        visibleItems: filteredRepositories.value.slice(startIndex, endIndex),
        offsetY: startIndex * rowHeight,
        totalHeight: total * rowHeight
      };
    });

    // 分页控制方法
    const goToPage = (page) => {
      if (page >= 1 && page <= totalPages.value) {
        currentPage.value = page;
      }
    };

    const previousPage = () => {
      if (currentPage.value > 1) {
        currentPage.value--;
      }
    };

    const nextPage = () => {
      if (currentPage.value < totalPages.value) {
        currentPage.value++;
      }
    };

    // 重置分页到第一页
    const resetPagination = () => {
      currentPage.value = 1;
    };

    // 应用自定义页面大小
    const applyCustomPageSize = () => {
      if (customPageSize.value > 0 && customPageSize.value <= 1000) {
        pageSize.value = customPageSize.value;
        resetPagination();
      } else {
        alert('请输入1-1000之间的数字');
      }
    };

    // 监听过滤条件变化，重置分页
    Vue.watch([searchQueryDebounced, showErrorsOnly, timeFilter], () => {
      resetPagination();
    });

    // 统计信息
    const stats = computed(() => {
      const total = repositories.value.length;
      const active = repositories.value.filter(r => r.status === 'active').length;
      const pending = repositories.value.filter(r => r.status === 'pending').length;
      const error = repositories.value.filter(r => r.status === 'error').length;
      
      return { total, active, pending, error };
    });

    // API请求方法
    const apiRequest = async (endpoint, options = {}) => {
      const url = `/api${endpoint}`;
      const config = {
        headers: {
          'Content-Type': 'application/json',
        },
        ...options
      };

      if (config.body && typeof config.body === 'object') {
        config.body = JSON.stringify(config.body);
      }

      const response = await fetch(url, config);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      return response.json();
    };

    // 加载仓库数据
    const loadRepositories = async () => {
      try {
        isLoading.value = true;
        console.log('开始加载仓库数据...');
        
        const data = await apiRequest('/status');
        repositories.value = data || [];
        lastUpdateTime.value = new Date().toLocaleString();
        
        console.log(`成功加载 ${data.length} 个仓库`);
      } catch (err) {
        error.value = err.message;
        console.error('加载仓库数据失败:', err);
      } finally {
        isLoading.value = false;
      }
    };

    // 添加仓库
    const addRepository = async () => {
      if (!newRepoName.value.trim()) return;
      
      try {
        const result = await apiRequest('/repositories', {
          method: 'POST',
          body: { name: newRepoName.value.trim() }
        });
        
        repositories.value.unshift(result);
        newRepoName.value = '';
        console.log('仓库添加成功:', result.name);
      } catch (err) {
        error.value = `添加仓库失败: ${err.message}`;
        console.error('添加仓库失败:', err);
      }
    };

    // 批量添加仓库（整合了完整的导入功能）
    const batchAddRepositories = async () => {
      if (!batchImportText.value.trim()) {
        alert('请输入要批量添加的仓库名称');
        return;
      }
      
      // 解析输入的仓库列表，支持URL格式
      const lines = batchImportText.value.split('\n').filter(line => line.trim());
      const validRepos = lines.map(line => {
        const cleaned = line.trim().replace(/^https?:\/\/(www\.)?github\.com\//, '');
        return cleaned;
      }).filter(line => /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(line));
      
      if (validRepos.length === 0) {
        alert('未找到有效的仓库名称（格式：owner/repo）');
        return;
      }
      
      if (!confirm(`确定要批量添加 ${validRepos.length} 个仓库吗？`)) {
        return;
      }
      
      isImporting.value = true;
      importCancelled.value = false;
      importPaused.value = false;
      importProgress.value = { current: 0, total: validRepos.length };
      importResults.value = [];
      importStatus.value = '开始导入...';
      
      try {
        // 首先尝试批量导入
        const result = await apiRequest('/repositories/batch-quick-add', {
          method: 'POST',
          body: { names: validRepos }
        });
        
        // 处理成功添加的仓库
        if (result.added_repositories) {
          result.added_repositories.forEach(repo => {
            importResults.value.push({
              name: repo.name,
              success: true,
              status: 'pending'
            });
          });
        }
        
        // 处理失败的仓库
        if (result.failures) {
          result.failures.forEach(failure => {
            const parts = failure.split(': ');
            const repoName = parts[0];
            const error = parts[1] || 'Unknown error';
            importResults.value.push({
              name: repoName,
              success: false,
              error: error
            });
          });
        }
        
        // 处理重复的仓库
        if (result.duplicates) {
          result.duplicates.forEach(repo => {
            importResults.value.push({
              name: repo,
              success: false,
              skipped: true,
              error: 'Already exists'
            });
          });
        }
        
        importProgress.value.current = validRepos.length;
        importStatus.value = `批量导入完成 - ${result.success || result.added_repositories?.length || 0} 个仓库已排队处理`;
        
        await loadRepositories();
        
      } catch (batchError) {
        // 批量导入失败，回退到逐个导入
        console.log('批量导入失败，回退到逐个导入:', batchError);
        importStatus.value = '批量导入失败，切换到逐个导入...';
        
        for (let i = 0; i < validRepos.length; i++) {
          if (importCancelled.value) break;
          
          // 等待暂停状态
          while (importPaused.value && !importCancelled.value) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          
          if (importCancelled.value) break;
          
          const repoName = validRepos[i];
          importStatus.value = `正在导入 ${repoName}... (${i + 1}/${validRepos.length})`;
          
          try {
            const result = await apiRequest('/repositories', {
              method: 'POST',
              body: { name: repoName }
            });
            
            importResults.value.push({
              name: repoName,
              success: true,
              status: 'pending'
            });
            
          } catch (err) {
            const isDuplicate = err.message.includes('already exists') || err.message.includes('duplicate');
            
            importResults.value.push({
              name: repoName,
              success: false,
              skipped: isDuplicate && importOptions.value.skipExisting,
              error: err.message
            });
            
            if (!importOptions.value.continueOnError && !isDuplicate) {
              break;
            }
          }
          
          importProgress.value.current = i + 1;
          
          // 防止请求过快
          if (!importCancelled.value) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
        
        await loadRepositories();
      }
      
      isImporting.value = false;
      
      if (importCancelled.value) {
        importStatus.value = `导入已取消 (${importResults.value.filter(r => r.success).length} 个已导入)`;
      } else {
        importStatus.value = '导入完成';
        
        // 显示完成摘要
        const successCount = importResults.value.filter(r => r.success).length;
        const failureCount = importResults.value.filter(r => !r.success && !r.skipped).length;
        const skippedCount = importResults.value.filter(r => r.skipped).length;
        
        let message = `导入完成！\n✓ 成功: ${successCount}`;
        if (failureCount > 0) message += `\n✗ 失败: ${failureCount}`;
        if (skippedCount > 0) message += `\n⏭️ 跳过: ${skippedCount}`;
        
        // 清空输入框
        batchImportText.value = '';
      }
    };

    // 内部删除仓库函数（不带确认框）
    const deleteRepositoryInternal = async (repoName) => {
      const parts = repoName.split('/');
      await apiRequest(`/repositories/${parts[0]}/${parts[1]}`, {
        method: 'DELETE'
      });
      
      repositories.value = repositories.value.filter(r => r.name !== repoName);
      selectedRepos.value = selectedRepos.value.filter(r => r !== repoName);
    };

    // 删除仓库（带确认框）
    const deleteRepository = async (repoName) => {
      if (!confirm(`确定要删除仓库 ${repoName} 吗？`)) return;
      
      try {
        await deleteRepositoryInternal(repoName);
        console.log('仓库删除成功:', repoName);
      } catch (err) {
        error.value = `删除仓库失败: ${err.message}`;
        console.error('删除仓库失败:', err);
      }
    };

    // 刷新仓库
    const refreshRepository = async (repoName) => {
      try {
        const parts = repoName.split('/');
        await apiRequest(`/repositories/${parts[0]}/${parts[1]}/check`, {
          method: 'POST'
        });
        
        await loadRepositories();
        console.log('仓库刷新成功:', repoName);
      } catch (err) {
        error.value = `刷新仓库失败: ${err.message}`;
        console.error('刷新仓库失败:', err);
      }
    };

    // 全选功能
    const toggleSelectAll = () => {
      if (selectAll.value) {
        selectedRepos.value = filteredRepositories.value.map(r => r.name);
      } else {
        selectedRepos.value = [];
      }
    };

    // 切换单个选择
    const toggleRepoSelection = (repoName) => {
      const index = selectedRepos.value.indexOf(repoName);
      if (index > -1) {
        selectedRepos.value.splice(index, 1);
      } else {
        selectedRepos.value.push(repoName);
      }
    };

    // 批量删除
    const batchDelete = async () => {
      if (selectedRepos.value.length === 0) {
        alert('请先选择要删除的仓库');
        return;
      }
      
      if (!confirm(`确定要删除选中的 ${selectedRepos.value.length} 个仓库吗？`)) return;
      
      const totalCount = selectedRepos.value.length;
      let successCount = 0;
      let failedCount = 0;
      const failedRepos = [];
      
      try {
        for (const repoName of selectedRepos.value) {
          try {
            await deleteRepositoryInternal(repoName);
            successCount++;
            console.log(`删除成功: ${repoName} (${successCount}/${totalCount})`);
          } catch (err) {
            failedCount++;
            failedRepos.push(repoName);
            console.error(`删除失败: ${repoName}`, err);
          }
        }
        
        selectedRepos.value = [];
        selectAll.value = false;
        
        // 显示结果摘要
        if (failedCount === 0) {
          alert(`批量删除完成！成功删除 ${successCount} 个仓库。`);
        } else {
          alert(`批量删除完成！\n成功删除: ${successCount} 个\n失败: ${failedCount} 个\n失败的仓库: ${failedRepos.join(', ')}`);
        }
        
        console.log('批量删除完成:', { successCount, failedCount, failedRepos });
      } catch (err) {
        error.value = `批量删除过程中发生错误: ${err.message}`;
        console.error('批量删除错误:', err);
      }
    };

    // 刷新选中的仓库
    const refreshSelected = async () => {
      if (selectedRepos.value.length === 0) {
        alert('请先选择要刷新的仓库');
        return;
      }
      
      try {
        for (const repoName of selectedRepos.value) {
          await refreshRepository(repoName);
        }
        console.log('批量刷新成功');
      } catch (err) {
        error.value = `批量刷新失败: ${err.message}`;
        console.error('批量刷新失败:', err);
      }
    };

    // 手动检测所有仓库
    const manualCheckAll = async () => {
      if (checkingAll.value) return;
      
      if (!confirm(`确定要检测所有 ${repositories.value.length} 个仓库的状态吗？\n这可能需要一些时间。`)) {
        return;
      }
      
      checkingAll.value = true;
      try {
        const response = await apiRequest('/repositories/check-all', {
          method: 'POST'
        });
        
        alert(`已开始检测所有 ${response.total_count} 个仓库\n检测将在后台进行，请稍等片刻后刷新查看结果。`);
        
        // 5秒后自动刷新一次
        setTimeout(() => {
          loadRepositories();
        }, 5000);
        
        // 15秒后再次刷新
        setTimeout(() => {
          loadRepositories();
        }, 15000);
        
      } catch (err) {
        error.value = `检测所有仓库失败: ${err.message}`;
        console.error('检测所有仓库失败:', err);
      } finally {
        checkingAll.value = false;
      }
    };

    // 加载预设仓库
    const loadPreset = () => {
      if (!selectedPreset.value) return;
      
      const repos = presetRepos[selectedPreset.value] || [];
      if (repos.length > 0) {
        if (importText.value.trim()) {
          importText.value += '\n' + repos.join('\n');
        } else {
          importText.value = repos.join('\n');
        }
      }
    };

    // 获取有效仓库数量
    const getValidRepoCount = () => {
      if (!importText.value) return 0;
      const lines = importText.value.split('\n').filter(line => line.trim());
      const validRepos = lines.filter(line => {
        const cleaned = line.trim().replace(/^https?:\/\/(www\.)?github\.com\//, '');
        return /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(cleaned);
      });
      return validRepos.length;
    };

    // 清空导入文本
    const clearImportText = () => {
      importText.value = '';
      importResults.value = [];
      importStats.value = { total: 0, success: 0, failed: 0, duplicates: 0 };
    };

    // 导入控制功能
    const pauseImport = () => {
      importPaused.value = true;
      importStatus.value = '导入已暂停';
    };

    const resumeImport = () => {
      importPaused.value = false;
      importStatus.value = '导入继续中...';
    };

    const stopImport = () => {
      importCancelled.value = true;
      importPaused.value = false;
      isImporting.value = false;
      importStatus.value = `导入已取消 (${importResults.value.filter(r => r.success).length} 个已导入)`;
    };

    const resetImport = () => {
      importCancelled.value = false;
      importPaused.value = false;
      isImporting.value = false;
      importProgress.value = { current: 0, total: 0 };
      importResults.value = [];
      importStatus.value = '';
    };

    // 加载配置（后端下划线 → 前端驼峰）
    const loadConfig = async () => {
      try {
        const data = await apiRequest('/config');
        config.value.updateInterval = data.update_interval ?? config.value.updateInterval;
        config.value.initialDelay = data.initial_delay ?? config.value.initialDelay;
        config.value.maxConcurrentRequests = data.max_concurrent_requests ?? config.value.maxConcurrentRequests;
        config.value.requestDelay = data.request_delay ?? config.value.requestDelay;
        config.value.hasToken = !!data.has_token;
      } catch (err) {
        console.error('加载配置失败:', err);
      }
    };

    // 保存配置（前端驼峰 → 后端下划线；仅在填写时发送 github_token）
    const saveConfig = async () => {
      try {
        const payload = {
          update_interval: Number(config.value.updateInterval),
          initial_delay: Number(config.value.initialDelay),
          max_concurrent_requests: Number(config.value.maxConcurrentRequests),
          request_delay: Number(config.value.requestDelay)
        };
        const trimmedToken = (config.value.githubToken || '').trim();
        if (trimmedToken) {
          payload.github_token = trimmedToken;
        }

        await apiRequest('/config', {
          method: 'POST',
          body: payload
        });

        if (trimmedToken) {
          config.value.githubToken = '';
          config.value.hasToken = true;
        }

        alert('配置保存成功！');
        showConfigModal.value = false;
        
        await Promise.all([loadConfig(), loadStatus()]);
      } catch (err) {
        error.value = `保存配置失败: ${err.message}`;
        console.error('保存配置失败:', err);
      }
    };

    // 加载队列状态
    const fetchQueueStatus = async () => {
      try {
        const data = await apiRequest('/repositories/queue-status');
        queueStatus.value = data;
      } catch (err) {
        console.error('加载队列状态失败:', err);
      }
    };

    // 加载GitHub状态
    const fetchGitHubStatus = async () => {
      try {
        const data = await apiRequest('/github/status');
        githubStatus.value = data;
      } catch (err) {
        console.error('加载GitHub状态失败:', err);
      }
    };

    // 刷新GitHub状态
    const refreshGitHubStatus = async () => {
      try {
        const response = await apiRequest('/github/status/refresh', { method: 'POST' });
        githubStatus.value = response;
      } catch (err) {
        error.value = `刷新GitHub状态失败: ${err.message}`;
        console.error('刷新GitHub状态失败:', err);
      }
    };

    // 加载状态信息
    const loadStatus = async () => {
      await Promise.all([fetchQueueStatus(), fetchGitHubStatus()]);
    };

    // GitHub API相关工具方法
    const getRateLimitPercent = (rateLimit) => {
      if (!rateLimit || !rateLimit.limit) return 0;
      return (rateLimit.used / rateLimit.limit) * 100;
    };

    const getRateLimitClass = (rateLimit) => {
      const percent = getRateLimitPercent(rateLimit);
      if (percent >= 90) return 'danger';
      if (percent >= 70) return 'warning';
      return '';
    };

    const formatResetTime = (resetTime) => {
      if (!resetTime) return 'N/A';
      const date = new Date(resetTime);
      const now = new Date();
      const diffMinutes = Math.ceil((date - now) / (1000 * 60));
      
      if (diffMinutes <= 0) return '已重置';
      if (diffMinutes < 60) return `${diffMinutes}分钟后`;
      const hours = Math.floor(diffMinutes / 60);
      const minutes = diffMinutes % 60;
      return `${hours}小时${minutes}分钟后`;
    };

    const formatLastChecked = (lastChecked) => {
      if (!lastChecked) return 'N/A';
      const date = new Date(lastChecked);
      const now = new Date();
      const diffMinutes = Math.floor((now - date) / (1000 * 60));
      
      if (diffMinutes < 1) return '刚刚';
      if (diffMinutes < 60) return `${diffMinutes}分钟前`;
      const hours = Math.floor(diffMinutes / 60);
      if (hours < 24) return `${hours}小时前`;
      const days = Math.floor(hours / 24);
      return `${days}天前`;
    };

    const formatDate = (dateStr) => {
      if (!dateStr) return 'N/A';
      try {
        return new Date(dateStr).toLocaleString('zh-CN');
      } catch {
        return dateStr;
      }
    };

    // 工具方法
    const formatTimeAgo = (date) => {
      const now = new Date();
      const past = new Date(date);
      const diffMs = now - past;
      
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);
      
      if (diffMins < 1) return '刚刚';
      if (diffMins < 60) return `${diffMins}分钟前`;
      if (diffHours < 24) return `${diffHours}小时前`;
      return `${diffDays}天前`;
    };

    const truncateText = (text, length = 50) => {
      if (!text) return '';
      return text.length > length ? text.substring(0, length) + '...' : text;
    };

    // 计算批量输入中有效仓库数量
    const getBatchValidRepoCount = () => {
      if (!batchImportText.value) return 0;
      const lines = batchImportText.value.split('\n').filter(line => line.trim());
      const validRepos = lines.map(line => {
        const cleaned = line.trim().replace(/^https?:\/\/(www\.)?github\.com\//, '');
        return cleaned;
      }).filter(line => /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(line));
      return validRepos.length;
    };

    // 手动检测单个仓库
    const manualCheckRepository = async (repoName) => {
      if (checkingRepos.value.includes(repoName)) return;
      
      checkingRepos.value.push(repoName);
      try {
        const parts = repoName.split('/');
        await apiRequest(`/repositories/${parts[0]}/${parts[1]}/check`, {
          method: 'POST'
        });
        
        setTimeout(() => {
          loadRepositories();
        }, 2000);
        
      } catch (err) {
        error.value = `检测仓库失败: ${err.message}`;
      } finally {
        checkingRepos.value = checkingRepos.value.filter(r => r !== repoName);
      }
    };

    // 组件挂载
    onMounted(() => {
      console.log('MainApp 组件已挂载');
      loadRepositories();
      loadConfig();
      loadStatus();
      
      // 定时刷新
      setInterval(() => {
        loadRepositories();
        loadStatus();
      }, 30000);
    });

    return {
      // 基础状态
      repositories,
      isLoading,
      error,
      lastUpdateTime,
      
      // 性能优化状态
      pageSize,
      currentPage,
      customPageSize,
      virtualScrollContainer,
      tableHeight,
      itemHeight,
      
      // 过滤和搜索
      searchQuery,
      searchQueryDebounced,
      sortBy,
      showErrorsOnly,
      timeFilter,
      filteredRepositories,
      paginatedRepositories,
      virtualScrollData,
      totalPages,
      
      // 选择状态
      selectedRepos,
      selectAll,
      
      // 表单输入
      newRepoName,
      
      // 添加模式
      importMode,
      batchImportText,
      
      // 模态框状态
      showConfigModal,
      showStatusPanel,
      
      // 导入功能
      isImporting,
      importProgress,
      importStats,
      importResults,
      importStatus,
      importPaused,
      importCancelled,
      importOptions,
      
      // 配置
      config,
      
      // 状态面板
      queueStatus,
      githubStatus,
      checkingRepos,
      checkingAll,
      
      // 统计信息
      stats,
      
      // 方法
      addRepository,
      batchAddRepositories,
      deleteRepository,
      refreshRepository,
      batchDelete,
      refreshSelected,
      toggleSelectAll,
      toggleRepoSelection,
      loadRepositories,
      formatTimeAgo,
      truncateText,
      
      // 分页方法
      goToPage,
      previousPage,
      nextPage,
      resetPagination,
      applyCustomPageSize,
      
      // 导入方法
      loadPreset,
      getValidRepoCount,
      clearImportText,
      pauseImport,
      resumeImport,
      stopImport,
      resetImport,
      
      // 配置方法
      loadConfig,
      saveConfig,
      
      // 状态方法
      fetchQueueStatus,
      fetchGitHubStatus,
      refreshGitHubStatus,
      loadStatus,
      
      // 检测方法
      manualCheckAll,
      manualCheckRepository,
      
      // 工具方法
      getRateLimitPercent,
      getRateLimitClass,
      formatResetTime,
      formatLastChecked,
      formatDate,
      getBatchValidRepoCount
    };
  },
  template: `
    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh;">
      <!-- 主容器 -->
      <div style="max-width: 1400px; margin: 0 auto; padding: 2em; position: relative;">
        
        <!-- 头部区域 -->
        <div style="text-align: center; margin-bottom: 3em; color: white;">
          <h1 style="font-size: 3em; font-weight: 700; margin: 0 0 0.5em 0; text-shadow: 0 2px 4px rgba(0,0,0,0.3); background: linear-gradient(45deg, #fff, #e0e7ff); background-clip: text; -webkit-background-clip: text; -webkit-text-fill-color: transparent;">
           GitHub 仓库监控器
          </h1>
          <div style="font-size: 16px; opacity: 0.9; text-shadow: 0 1px 2px rgba(0,0,0,0.2);">
            <span style="display: inline-flex; align-items: center; gap: 0.5em;">
              <span style="width: 8px; height: 8px; background: #10b981; border-radius: 50%; box-shadow: 0 0 8px rgba(16, 185, 129, 0.6);"></span>
              最后更新: {{ lastUpdateTime || '未更新' }}
            </span>
          </div>
        </div>

        <!-- 仓库管理操作区 -->
        <div class="repo-management-area" style="background: rgba(255,255,255,0.95); backdrop-filter: blur(20px); border-radius: 20px; padding: 2em; margin-bottom: 2em; box-shadow: 0 8px 32px rgba(0,0,0,0.1); border: 1px solid rgba(255,255,255,0.2);">
          <!-- 顶部操作按钮行 -->
          <div class="top-buttons" style="display: flex; flex-wrap: wrap; gap: 1em; justify-content: space-between; align-items: center; margin-bottom: 1.5em;">
            <div class="button-group" style="display: flex; flex-wrap: wrap; gap: 0.75em;">
              <button type="button" @click="showConfigModal = true" style="background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); color: white; font-weight: 600; border: none; padding: 12px 18px; border-radius: 12px; cursor: pointer; font-size: 14px; transition: all 0.3s ease; box-shadow: 0 4px 16px rgba(139, 92, 246, 0.3); display: flex; align-items: center; gap: 0.5em;"
                @mouseover="$event.target.style.transform='translateY(-2px)'; $event.target.style.boxShadow='0 6px 20px rgba(139, 92, 246, 0.4)'"
                @mouseout="$event.target.style.transform='translateY(0)'; $event.target.style.boxShadow='0 4px 16px rgba(139, 92, 246, 0.3)'">
                <svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
                  <path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492zM5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0z"/>
                  <path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52l-.094-.319zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 2.693 1.115l.292-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 0 0 1.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 0 0-1.115 2.693l.16.292c.415.764-.42 1.6-1.185 1.184l-.292-.159a1.873 1.873 0 0 0-2.692 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 0 0-2.693-1.115l-.292.16c-.764.415-1.6-.42-1.184-1.185l.159-.292A1.873 1.873 0 0 0 1.945 8.93l-.319-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 0 0 3.06 4.377l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 0 0 2.692-1.115l.094-.319z"/>
                </svg>
                系统配置
              </button>
              
              <button type="button" @click="showStatusPanel = !showStatusPanel" style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; font-weight: 600; border: none; padding: 12px 18px; border-radius: 12px; cursor: pointer; font-size: 14px; transition: all 0.3s ease; box-shadow: 0 4px 16px rgba(16, 185, 129, 0.3); display: flex; align-items: center; gap: 0.5em;"
                @mouseover="$event.target.style.transform='translateY(-2px)'; $event.target.style.boxShadow='0 6px 20px rgba(16, 185, 129, 0.4)'"
                @mouseout="$event.target.style.transform='translateY(0)'; $event.target.style.boxShadow='0 4px 16px rgba(16, 185, 129, 0.3)'">
                <svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
                  <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0zM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0z"/>
                  <path d="M8 4a.5.5 0 0 1 .5.5v3.793l2.146-2.147a.5.5 0 0 1 .708.708l-3 3a.5.5 0 0 1-.708 0l-3-3a.5.5 0 1 1 .708-.708L7.5 8.293V4.5A.5.5 0 0 1 8 4z"/>
                </svg>
                {{ showStatusPanel ? '隐藏状态' : '系统状态' }}
              </button>
            </div>
            
            <!-- 右侧刷新按钮 -->
            <button @click="loadRepositories" :disabled="isLoading" style="background: linear-gradient(135deg, #06b6d4 0%, #0891b2 100%); color: white; font-weight: 600; border: none; padding: 12px 20px; border-radius: 12px; cursor: pointer; font-size: 14px; transition: all 0.3s ease; box-shadow: 0 4px 16px rgba(6, 182, 212, 0.3); display: flex; align-items: center; gap: 0.5em;"
              @mouseover="$event.target.style.transform='translateY(-2px)'; $event.target.style.boxShadow='0 6px 20px rgba(6, 182, 212, 0.4)'"
              @mouseout="$event.target.style.transform='translateY(0)'; $event.target.style.boxShadow='0 4px 16px rgba(6, 182, 212, 0.3)'"
              :style="{ opacity: isLoading ? 0.6 : 1 }">
              <svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16" :style="{ animation: isLoading ? 'spin 1s linear infinite' : 'none' }">
                <path fill-rule="evenodd" d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2v1z"/>
                <path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/>
              </svg>
              {{ isLoading ? '刷新中...' : '刷新' }}
            </button>
          </div>
          
          <!-- 添加仓库区域 -->
          <div class="add-repo-area" style="background: rgba(248, 250, 252, 0.8); border-radius: 16px; padding: 1.5em; margin-bottom: 1.5em; border: 1px solid rgba(226, 232, 240, 0.5);">
            <div class="mode-switch" style="display: flex; align-items: center; gap: 0.75em; margin-bottom: 1em;">
              <h3 style="margin: 0; font-size: 16px; font-weight: 600; color: #374151;">添加仓库</h3>
              <div style="display: flex; background: rgba(255, 255, 255, 0.8); border-radius: 8px; padding: 2px; border: 1px solid #e5e7eb;">
                <button type="button" @click="importMode = 'single'" 
                  :style="{ 
                    background: importMode === 'single' ? 'linear-gradient(135deg, #10b981 0%, #059669 100%)' : 'transparent',
                    color: importMode === 'single' ? 'white' : '#374151',
                    border: 'none',
                    padding: '6px 12px',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '12px',
                    fontWeight: '500',
                    transition: 'all 0.2s ease'
                  }">
                  单个添加
                </button>
                <button type="button" @click="importMode = 'batch'" 
                  :style="{ 
                    background: importMode === 'batch' ? 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)' : 'transparent',
                    color: importMode === 'batch' ? 'white' : '#374151',
                    border: 'none',
                    padding: '6px 12px',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '12px',
                    fontWeight: '500',
                    transition: 'all 0.2s ease'
                  }">
                  批量添加
                </button>
              </div>
            </div>
            
            <!-- 单个添加模式 -->
            <div v-if="importMode === 'single'" class="single-add-form">
              <div class="single-add-container">
                <div class="input-section">
                  <label style="display: block; font-size: 12px; color: #6b7280; margin-bottom: 0.5em; font-weight: 500;">仓库名称</label>
                  <div style="position: relative;">
                    <input 
                      v-model.trim="newRepoName" 
                      placeholder="例如: facebook/react" 
                      class="repo-input"
                      style="width: 100%; padding: 12px 16px 12px 44px; border-radius: 10px; border: 2px solid #e5e7eb; font-size: 14px; transition: all 0.3s ease; background: white; box-shadow: 0 2px 8px rgba(0,0,0,0.05);"
                      @focus="$event.target.style.borderColor='#10b981'; $event.target.style.boxShadow='0 0 0 3px rgba(16, 185, 129, 0.1), 0 4px 12px rgba(0,0,0,0.1)'"
                      @blur="$event.target.style.borderColor='#e5e7eb'; $event.target.style.boxShadow='0 2px 8px rgba(0,0,0,0.05)'"
                      @keydown.enter="addRepository"
                    >
                    <div style="position: absolute; left: 14px; top: 50%; transform: translateY(-50%); color: #9ca3af;">
                      <svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
                        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.03 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
                      </svg>
                    </div>
                  </div>
                </div>
                <div class="button-section">
                  <button @click="addRepository" :disabled="isLoading || !newRepoName.trim()" class="add-button" style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; font-weight: 600; border: none; padding: 12px 20px; border-radius: 10px; cursor: pointer; font-size: 14px; transition: all 0.3s ease; box-shadow: 0 4px 16px rgba(16, 185, 129, 0.3); display: flex; align-items: center; gap: 0.5em; white-space: nowrap; justify-content: center;" 
                    @mouseover="$event.target.style.transform='translateY(-2px)'; $event.target.style.boxShadow='0 6px 20px rgba(16, 185, 129, 0.4)'"
                    @mouseout="$event.target.style.transform='translateY(0)'; $event.target.style.boxShadow='0 4px 16px rgba(16, 185, 129, 0.3)'"
                    :style="{ opacity: (isLoading || !newRepoName.trim()) ? 0.6 : 1 }">
                    <svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
                      <path d="M8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4z"/>
                    </svg>
                    添加仓库
                  </button>
                </div>
              </div>
            </div>
            
            <!-- 批量添加模式 -->
            <div v-if="importMode === 'batch'">
              <label style="display: block; font-size: 12px; color: #6b7280; margin-bottom: 0.5em; font-weight: 500;">批量仓库列表</label>
              <textarea 
                v-model="batchImportText" 
                placeholder="每行一个仓库名称，例如:\nfacebook/react\nvuejs/vue\nmicrosoft/TypeScript\n# 井号开头的行将被忽略\n\n支持URL格式:\nhttps://github.com/facebook/react\ngithub.com/vuejs/vue"
                :disabled="isImporting"
                style="width: 100%; height: 120px; padding: 12px 16px; border-radius: 10px; border: 2px solid #e5e7eb; font-size: 14px; transition: all 0.3s ease; background: white; box-shadow: 0 2px 8px rgba(0,0,0,0.05); resize: vertical; font-family: 'JetBrains Mono', 'Fira Code', 'Monaco', monospace;"
                @focus="$event.target.style.borderColor='#3b82f6'; $event.target.style.boxShadow='0 0 0 3px rgba(59, 130, 246, 0.1), 0 4px 12px rgba(0,0,0,0.1)'"
                @blur="$event.target.style.borderColor='#e5e7eb'; $event.target.style.boxShadow='0 2px 8px rgba(0,0,0,0.05)'"
              ></textarea>

              <!-- 导入选项 -->
              <div style="margin: 1em 0; padding: 1em; background-color: rgba(248, 250, 252, 0.8); border-radius: 8px; border: 1px solid rgba(226, 232, 240, 0.8);">
                <label style="display: block; margin: 0.5em 0; font-size: 12px; color: #374151;">
                  <input type="checkbox" v-model="importOptions.skipExisting" :disabled="isImporting" style="margin-right: 0.5em;">
                  跳过已存在的仓库
                </label>
                <label style="display: block; margin: 0.5em 0; font-size: 12px; color: #374151;">
                  <input type="checkbox" v-model="importOptions.continueOnError" :disabled="isImporting" style="margin-right: 0.5em;">
                  即使某些仓库失败也继续导入
                </label>
              </div>

              <!-- 导入统计 -->
              <div v-if="importResults.length > 0" style="display: flex; gap: 1em; margin: 1em 0; font-size: 12px;">
                <div style="padding: 0.5em; background-color: #d4edda; color: #155724; border-radius: 4px; font-weight: 500;">
                  ✓ 成功: {{ importResults.filter(r => r.success).length }}
                </div>
                <div style="padding: 0.5em; background-color: #f8d7da; color: #721c24; border-radius: 4px; font-weight: 500;">
                  ✗ 失败: {{ importResults.filter(r => !r.success && !r.skipped).length }}
                </div>
                <div v-if="importResults.filter(r => r.skipped).length > 0" style="padding: 0.5em; background-color: #fff3cd; color: #856404; border-radius: 4px; font-weight: 500;">
                  ⏭️ 跳过: {{ importResults.filter(r => r.skipped).length }}
                </div>
                <div style="padding: 0.5em; background-color: #f0f2f5; border-radius: 4px; font-weight: 500;">
                  总计: {{ importResults.length }}
                </div>
              </div>

              <!-- 进度显示 -->
              <div v-if="isImporting" style="margin: 1em 0;">
                <p style="margin: 0 0 0.5em 0; font-size: 13px; color: #374151; font-weight: 500;">{{ importStatus }} {{ importProgress.current }} / {{ importProgress.total }}</p>
                <div style="width: 100%; height: 6px; background-color: #e1e4e8; border-radius: 3px; overflow: hidden;">
                  <div style="height: 100%; background: linear-gradient(90deg, #3b82f6, #1d4ed8); transition: width 0.3s;" :style="{ width: (importProgress.current / importProgress.total * 100) + '%' }"></div>
                </div>
                
                <!-- 导入控制按钮 -->
                <div style="display: flex; gap: 0.5em; margin-top: 0.75em;">
                  <button v-if="!importPaused && !importCancelled" @click="pauseImport" style="padding: 6px 12px; border-radius: 6px; border: 1px solid #f59e0b; background-color: #f59e0b; color: white; font-size: 11px; cursor: pointer; font-weight: 500;">
                    ⏸️ 暂停
                  </button>
                  <button v-if="importPaused && !importCancelled" @click="resumeImport" style="padding: 6px 12px; border-radius: 6px; border: 1px solid #10b981; background-color: #10b981; color: white; font-size: 11px; cursor: pointer; font-weight: 500;">
                    ▶️ 继续
                  </button>
                  <button v-if="!importCancelled" @click="stopImport" style="padding: 6px 12px; border-radius: 6px; border: 1px solid #ef4444; background-color: #ef4444; color: white; font-size: 11px; cursor: pointer; font-weight: 500;">
                    ⏹️ 终止
                  </button>
                  <span v-if="importPaused" style="color: #f59e0b; font-weight: 600; margin-left: 1em; font-size: 11px;">已暂停</span>
                  <span v-if="importCancelled" style="color: #ef4444; font-weight: 600; margin-left: 1em; font-size: 11px;">已终止</span>
                </div>

                <!-- 实时结果展示 -->
                <div v-if="importResults.length > 0" style="margin-top: 1em; max-height: 120px; overflow-y: auto; background: white; border-radius: 6px; padding: 0.75em; border: 1px solid #e5e7eb;">
                  <div v-for="result in importResults" :key="result.name" style="padding: 2px 0; font-size: 11px;">
                    <span :style="{ color: result.success ? '#10b981' : result.skipped ? '#f59e0b' : '#ef4444', fontWeight: '500' }">
                      {{ result.success ? '✓' : result.skipped ? '⏭️' : '✗' }} {{ result.name }}
                      <span v-if="!result.success && result.error" style="font-size: 10px; color: #6b7280;"> - {{ result.error }}</span>
                    </span>
                  </div>
                </div>
              </div>

              <div class="batch-add-bottom" style="display: flex; justify-content: space-between; align-items: center; margin-top: 0.75em;">
                <div style="font-size: 12px; color: #6b7280;">
                  <span v-if="batchImportText.trim()">
                    检测到 {{ getBatchValidRepoCount() }} 个有效仓库
                  </span>
                  <span v-else>支持格式：owner/repo 或 GitHub URL，每行一个</span>
                </div>
                <button v-if="!isImporting" @click="batchAddRepositories" :disabled="isLoading || !batchImportText.trim()" style="background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); color: white; font-weight: 600; border: none; padding: 10px 18px; border-radius: 10px; cursor: pointer; font-size: 13px; transition: all 0.3s ease; box-shadow: 0 4px 16px rgba(59, 130, 246, 0.3); display: flex; align-items: center; gap: 0.5em;" 
                  @mouseover="$event.target.style.transform='translateY(-2px)'; $event.target.style.boxShadow='0 6px 20px rgba(59, 130, 246, 0.4)'"
                  @mouseout="$event.target.style.transform='translateY(0)'; $event.target.style.boxShadow='0 4px 16px rgba(59, 130, 246, 0.3)'"
                  :style="{ opacity: (isLoading || !batchImportText.trim()) ? 0.6 : 1 }">
                  <svg width="14" height="14" fill="currentColor" viewBox="0 0 16 16">
                    <path d="M8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4z"/>
                  </svg>
                  开始导入
                </button>
              </div>
            </div>
          </div>
          
          <!-- 搜索和过滤区域 -->
          <div class="search-filters">
            <div class="search-filter-container">
              <div class="search-input-container">
                <input 
                  v-model="searchQuery" 
                  placeholder="搜索仓库名称、描述..." 
                  class="search-input"
                  style="width: 100%; padding: 12px 16px 12px 44px; border-radius: 12px; border: 2px solid #e5e7eb; font-size: 14px; transition: all 0.3s ease; background: white; box-shadow: 0 2px 8px rgba(0,0,0,0.05);"
                  @focus="$event.target.style.borderColor='#6366f1'; $event.target.style.boxShadow='0 0 0 3px rgba(99, 102, 241, 0.1), 0 4px 12px rgba(0,0,0,0.1)'"
                  @blur="$event.target.style.borderColor='#e5e7eb'; $event.target.style.boxShadow='0 2px 8px rgba(0,0,0,0.05)'"
                >
                <div style="position: absolute; left: 16px; top: 50%; transform: translateY(-50%); color: #9ca3af;">
                  <svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
                    <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/>
                  </svg>
                </div>
              </div>
              
              <div class="sort-select-container">
                <select v-model="sortBy" class="sort-select" style="width: 100%; padding: 12px 16px; border-radius: 12px; border: 2px solid #e5e7eb; font-size: 14px; background: white; cursor: pointer; transition: all 0.3s ease; box-shadow: 0 2px 8px rgba(0,0,0,0.05);"
                  @focus="$event.target.style.borderColor='#6366f1'; $event.target.style.boxShadow='0 0 0 3px rgba(99, 102, 241, 0.1), 0 4px 12px rgba(0,0,0,0.1)'"
                  @blur="$event.target.style.borderColor='#e5e7eb'; $event.target.style.boxShadow='0 2px 8px rgba(0,0,0,0.05)'">
                  <option value="last_update">按最后更新时间</option>
                  <option value="name">按名称排序</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        <!-- 统计信息卡片 -->
        <div class="stats-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1.5em; margin-bottom: 2em;">
          <div style="background: rgba(255,255,255,0.95); backdrop-filter: blur(20px); border-radius: 16px; padding: 1.5em; box-shadow: 0 8px 32px rgba(0,0,0,0.1); border: 1px solid rgba(255,255,255,0.2); position: relative; overflow: hidden;">
            <div style="position: absolute; top: 0; left: 0; width: 100%; height: 4px; background: linear-gradient(90deg, #3b82f6, #8b5cf6);"></div>
            <div style="display: flex; align-items: center; justify-content: space-between;">
              <div>
                <div style="font-size: 28px; font-weight: 700; color: #1f2937; margin-bottom: 0.25em;">{{ stats.total }}</div>
                <div style="font-size: 14px; color: #6b7280; font-weight: 500;">总仓库数</div>
              </div>
              <div style="width: 48px; height: 48px; background: linear-gradient(135deg, #3b82f6, #8b5cf6); border-radius: 12px; display: flex; align-items: center; justify-content: center;">
                <svg width="24" height="24" fill="white" viewBox="0 0 16 16">
                  <path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.25 1.5h7.5a.75.75 0 0 1 0 1.5h-7.5A2.5 2.5 0 0 1 2 10.25v-7.5z"/>
                </svg>
              </div>
            </div>
          </div>
          
          <div style="background: rgba(255,255,255,0.95); backdrop-filter: blur(20px); border-radius: 16px; padding: 1.5em; box-shadow: 0 8px 32px rgba(0,0,0,0.1); border: 1px solid rgba(255,255,255,0.2); position: relative; overflow: hidden;">
            <div style="position: absolute; top: 0; left: 0; width: 100%; height: 4px; background: linear-gradient(90deg, #10b981, #059669);"></div>
            <div style="display: flex; align-items: center; justify-content: space-between;">
              <div>
                <div style="font-size: 28px; font-weight: 700; color: #059669; margin-bottom: 0.25em;">{{ stats.active }}</div>
                <div style="font-size: 14px; color: #6b7280; font-weight: 500;">活跃仓库</div>
              </div>
              <div style="width: 48px; height: 48px; background: linear-gradient(135deg, #10b981, #059669); border-radius: 12px; display: flex; align-items: center; justify-content: center;">
                <svg width="24" height="24" fill="white" viewBox="0 0 16 16">
                  <path d="M10.97 4.97a.235.235 0 0 0-.02.022L7.477 9.417 5.384 7.323a.75.75 0 0 0-1.06 1.061L6.97 11.03a.75.75 0 0 0 1.079-.02l3.992-4.99a.75.75 0 0 0-1.071-1.05z"/>
                </svg>
              </div>
            </div>
          </div>
          
          <div style="background: rgba(255,255,255,0.95); backdrop-filter: blur(20px); border-radius: 16px; padding: 1.5em; box-shadow: 0 8px 32px rgba(0,0,0,0.1); border: 1px solid rgba(255,255,255,0.2); position: relative; overflow: hidden;">
            <div style="position: absolute; top: 0; left: 0; width: 100%; height: 4px; background: linear-gradient(90deg, #f59e0b, #d97706);"></div>
            <div style="display: flex; align-items: center; justify-content: space-between;">
              <div>
                <div style="font-size: 28px; font-weight: 700; color: #d97706; margin-bottom: 0.25em;">{{ stats.pending }}</div>
                <div style="font-size: 14px; color: #6b7280; font-weight: 500;">等待处理</div>
              </div>
              <div style="width: 48px; height: 48px; background: linear-gradient(135deg, #f59e0b, #d97706); border-radius: 12px; display: flex; align-items: center; justify-content: center;">
                <svg width="24" height="24" fill="white" viewBox="0 0 16 16">
                  <path d="M8 3.5a.5.5 0 0 0-1 0V9a.5.5 0 0 0 .252.434l3.5 2a.5.5 0 0 0 .496-.868L8 8.71V3.5z"/>
                  <path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16zm7-8A7 7 0 1 1 1 8a7 7 0 0 1 14 0z"/>
                </svg>
              </div>
            </div>
          </div>
          
          <div style="background: rgba(255,255,255,0.95); backdrop-filter: blur(20px); border-radius: 16px; padding: 1.5em; box-shadow: 0 8px 32px rgba(0,0,0,0.1); border: 1px solid rgba(255,255,255,0.2); position: relative; overflow: hidden;">
            <div style="position: absolute; top: 0; left: 0; width: 100%; height: 4px; background: linear-gradient(90deg, #ef4444, #dc2626);"></div>
            <div style="display: flex; align-items: center; justify-content: space-between;">
              <div>
                <div style="font-size: 28px; font-weight: 700; color: #dc2626; margin-bottom: 0.25em;">{{ stats.error }}</div>
                <div style="font-size: 14px; color: #6b7280; font-weight: 500;">错误状态</div>
              </div>
              <div style="width: 48px; height: 48px; background: linear-gradient(135deg, #ef4444, #dc2626); border-radius: 12px; display: flex; align-items: center; justify-content: center;">
                <svg width="24" height="24" fill="white" viewBox="0 0 16 16">
                  <path d="M8.982 1.566a1.13 1.13 0 0 0-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 5.995A.905.905 0 0 1 8 5zm.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"/>
                </svg>
              </div>
            </div>
          </div>
        </div>

        <!-- 系统状态展示区域 -->
        <div v-if="showStatusPanel" style="margin-bottom: 2em; animation: slideDown 0.3s ease-out;">
          <!-- 后台处理队列状态面板 -->
          <div v-if="queueStatus" style="background: rgba(255,255,255,0.95); backdrop-filter: blur(20px); border-radius: 16px; padding: 1.5em; box-shadow: 0 8px 32px rgba(0,0,0,0.1); border: 1px solid rgba(255,255,255,0.2); margin-bottom: 1.5em; position: relative; overflow: hidden;">
            <div style="position: absolute; top: 0; left: 0; width: 100%; height: 4px; background: linear-gradient(90deg, #10b981, #059669);"></div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5em;">
              <div style="display: flex; align-items: center; gap: 0.75em;">
                <div style="width: 12px; height: 12px; background: linear-gradient(135deg, #10b981, #059669); border-radius: 50%; animation: pulse 2s infinite;"></div>
                <h3 style="margin: 0; color: #1f2937; font-size: 18px; font-weight: 600;">后台处理队列状态</h3>
              </div>
              <button @click="fetchQueueStatus" style="background: linear-gradient(135deg, #f3f4f6, #e5e7eb); color: #374151; font-weight: 500; border: none; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 12px; transition: all 0.3s ease; box-shadow: 0 2px 4px rgba(0,0,0,0.1);"
                @mouseover="$event.target.style.transform='translateY(-1px)'; $event.target.style.boxShadow='0 4px 8px rgba(0,0,0,0.15)'"
                @mouseout="$event.target.style.transform='translateY(0)'; $event.target.style.boxShadow='0 2px 4px rgba(0,0,0,0.1)'">
                🔄 刷新状态
              </button>
            </div>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 1em;">
              <div style="background: linear-gradient(135deg, rgba(59, 130, 246, 0.1), rgba(139, 92, 246, 0.1)); border-radius: 12px; padding: 1em; border: 1px solid rgba(59, 130, 246, 0.2); display: flex; flex-direction: column; align-items: center; text-align: center;">
                <div style="font-size: 24px; font-weight: 700; color: #3b82f6; margin-bottom: 0.25em;">{{ queueStatus.queue_length || 0 }}</div>
                <div style="font-size: 12px; color: #6b7280; font-weight: 500;">队列长度</div>
              </div>
              <div style="background: linear-gradient(135deg, rgba(245, 158, 11, 0.1), rgba(217, 119, 6, 0.1)); border-radius: 12px; padding: 1em; border: 1px solid rgba(245, 158, 11, 0.2); display: flex; flex-direction: column; align-items: center; text-align: center;">
                <div style="font-size: 24px; font-weight: 700; color: #f59e0b; margin-bottom: 0.25em;">{{ queueStatus.pending_count || 0 }}</div>
                <div style="font-size: 12px; color: #6b7280; font-weight: 500;">等待处理</div>
              </div>
              <div style="background: linear-gradient(135deg, rgba(16, 185, 129, 0.1), rgba(5, 150, 105, 0.1)); border-radius: 12px; padding: 1em; border: 1px solid rgba(16, 185, 129, 0.2); display: flex; flex-direction: column; align-items: center; text-align: center;">
                <div style="font-size: 24px; font-weight: 700; color: #10b981; margin-bottom: 0.25em;">{{ queueStatus.active_count || 0 }}</div>
                <div style="font-size: 12px; color: #6b7280; font-weight: 500;">已完成</div>
              </div>
              <div style="background: linear-gradient(135deg, rgba(239, 68, 68, 0.1), rgba(220, 38, 38, 0.1)); border-radius: 12px; padding: 1em; border: 1px solid rgba(239, 68, 68, 0.2); display: flex; flex-direction: column; align-items: center; text-align: center;">
                <div style="font-size: 24px; font-weight: 700; color: #ef4444; margin-bottom: 0.25em;">{{ queueStatus.error_count || 0 }}</div>
                <div style="font-size: 12px; color: #6b7280; font-weight: 500;">处理失败</div>
              </div>
              <div style="background: linear-gradient(135deg, rgba(107, 114, 128, 0.1), rgba(75, 85, 99, 0.1)); border-radius: 12px; padding: 1em; border: 1px solid rgba(107, 114, 128, 0.2); display: flex; flex-direction: column; align-items: center; text-align: center;">
                <div style="font-size: 24px; font-weight: 700; color: #6b7280; margin-bottom: 0.25em;">{{ queueStatus.total_repositories || 0 }}</div>
                <div style="font-size: 12px; color: #6b7280; font-weight: 500;">总计</div>
              </div>
            </div>
          </div>

          <!-- GitHub API状态面板 -->
          <div v-if="githubStatus" style="background: rgba(255,255,255,0.95); backdrop-filter: blur(20px); border-radius: 16px; padding: 1.5em; box-shadow: 0 8px 32px rgba(0,0,0,0.1); border: 1px solid rgba(255,255,255,0.2); position: relative; overflow: hidden;">
            <div style="position: absolute; top: 0; left: 0; width: 100%; height: 4px; background: linear-gradient(90deg, #6366f1, #8b5cf6);"></div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5em;">
              <div style="display: flex; align-items: center; gap: 0.75em;">
                <div :style="{ 
                  width: '12px', 
                  height: '12px', 
                  borderRadius: '50%', 
                  backgroundColor: githubStatus.token_valid ? '#10b981' : '#ef4444',
                  animation: githubStatus.token_valid ? 'pulse 2s infinite' : 'none'
                }"></div>
                <h3 style="margin: 0; color: #1f2937; font-size: 18px; font-weight: 600;">GitHub API 状态</h3>
                <span :style="{ 
                  color: githubStatus.token_valid ? '#10b981' : '#ef4444', 
                  fontWeight: '600',
                  fontSize: '14px',
                  padding: '2px 8px',
                  borderRadius: '12px',
                  backgroundColor: githubStatus.token_valid ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)'
                }">
                  {{ githubStatus.token_valid ? '✓ 正常' : '✗ 异常' }}
                </span>
              </div>
              <button @click="refreshGitHubStatus" style="background: linear-gradient(135deg, #f3f4f6, #e5e7eb); color: #374151; font-weight: 500; border: none; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 12px; transition: all 0.3s ease; box-shadow: 0 2px 4px rgba(0,0,0,0.1);"
                @mouseover="$event.target.style.transform='translateY(-1px)'; $event.target.style.boxShadow='0 4px 8px rgba(0,0,0,0.15)'"
                @mouseout="$event.target.style.transform='translateY(0)'; $event.target.style.boxShadow='0 2px 4px rgba(0,0,0,0.1)'">
                🔄 刷新状态
              </button>
            </div>
            
            <div v-if="githubStatus.token_valid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1.5em;">
              <div style="background: linear-gradient(135deg, rgba(99, 102, 241, 0.05), rgba(139, 92, 246, 0.05)); border-radius: 12px; padding: 1.25em; border: 1px solid rgba(99, 102, 241, 0.1);">
                <h4 style="margin: 0 0 0.75em 0; font-size: 14px; color: #6b7280; font-weight: 600; display: flex; align-items: center; gap: 0.5em;">
                  <svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
                    <path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm2-3a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm4 8c0 1-1 1-1 1H3s-1 0-1-1 1-4 6-4 6 3 6 4zm-1-.004c-.001-.246-.154-.986-.832-1.664C11.516 10.68 10.289 10 8 10c-2.29 0-3.516.68-4.168 1.332-.678.678-.83 1.418-.832 1.664h10z"/>
                  </svg>
                  用户信息
                </h4>
                <div style="font-size: 16px; font-weight: 600; color: #1f2937; margin-bottom: 0.5em;">{{ githubStatus.username || 'N/A' }}</div>
                <div style="font-size: 13px; color: #6b7280;">
                  Token类型: <span style="font-weight: 500; color: #374151;">{{ githubStatus.token_type || 'unknown' }}</span>
                </div>
              </div>
              
              <div style="background: linear-gradient(135deg, rgba(16, 185, 129, 0.05), rgba(5, 150, 105, 0.05)); border-radius: 12px; padding: 1.25em; border: 1px solid rgba(16, 185, 129, 0.1);">
                <h4 style="margin: 0 0 0.75em 0; font-size: 14px; color: #6b7280; font-weight: 600; display: flex; align-items: center; gap: 0.5em;">
                  <svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
                    <path d="M8 3.5a.5.5 0 0 0-1 0V9a.5.5 0 0 0 .252.434l3.5 2a.5.5 0 0 0 .496-.868L8 8.71V3.5z"/>
                    <path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16zm7-8A7 7 0 1 1 1 8a7 7 0 0 1 14 0z"/>
                  </svg>
                  API 速率限制
                </h4>
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75em;">
                  <span style="font-size: 16px; font-weight: 600; color: #1f2937;">{{ githubStatus.rate_limit?.used || 0 }}</span>
                  <div style="flex: 1; height: 8px; background-color: #e5e7eb; border-radius: 4px; margin: 0 1em; overflow: hidden;">
                    <div :style="{ 
                      height: '100%', 
                      width: getRateLimitPercent(githubStatus.rate_limit) + '%',
                      backgroundColor: getRateLimitClass(githubStatus.rate_limit) === 'danger' ? '#ef4444' : getRateLimitClass(githubStatus.rate_limit) === 'warning' ? '#f59e0b' : '#10b981',
                      transition: 'width 0.3s ease'
                    }"></div>
                  </div>
                  <span style="font-size: 16px; font-weight: 600, color: #1f2937;">{{ githubStatus.rate_limit?.limit || 0 }}</span>
                </div>
                <div style="font-size: 13px; color: #6b7280;">
                  剩余: <span style="font-weight: 500; color: #374151;">{{ githubStatus.rate_limit?.remaining || 0 }}</span> | 
                  重置: <span style="font-weight: 500; color: #374151;">{{ formatResetTime(githubStatus.rate_limit?.reset_time) }}</span>
                </div>
              </div>
              
              <div v-if="githubStatus.permissions && githubStatus.permissions.length > 0" style="background: linear-gradient(135deg, rgba(245, 158, 11, 0.05), rgba(217, 119, 6, 0.05)); border-radius: 12px; padding: 1.25em; border: 1px solid rgba(245, 158, 11, 0.1);">
                <h4 style="margin: 0 0 0.75em 0; font-size: 14px; color: #6b7280; font-weight: 600; display: flex; align-items: center; gap: 0.5em;">
                  <svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
                    <path d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 0 1-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.169.311c.446.82.023 1.841-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 0 1 .872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 0 1 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 0 1 2.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.169-.311a1.464 1.464 0 0 1 .872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 0 1-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464 1.464 0 0 1-2.105-.872l-.1-.34zM8 10.93a2.929 2.929 0 1 1 0-5.86 2.929 2.929 0 0 1 0 5.858z"/>
                  </svg>
                  Token 权限
                </h4>
                <div style="display: flex; gap: 0.5em; flex-wrap: wrap;">
                  <span v-for="permission in githubStatus.permissions" :key="permission" style="padding: 0.25em 0.75em; background: linear-gradient(135deg, #3b82f6, #6366f1); color: white; border-radius: 20px; font-size: 12px; font-weight: 500;">
                    {{ permission }}
                  </span>
                </div>
              </div>
              
              <div style="background: linear-gradient(135deg, rgba(107, 114, 128, 0.05), rgba(75, 85, 99, 0.05)); border-radius: 12px; padding: 1.25em; border: 1px solid rgba(107, 114, 128, 0.1);">
                <h4 style="margin: 0 0 0.75em 0; font-size: 14px; color: #6b7280; font-weight: 600; display: flex; align-items: center; gap: 0.5em;">
                  <svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
                    <path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0zM8 4a.905.905 0 0 0-.9.995l.35 3.507a.552.552 0 0 0 1.1 0l.35-3.507A.905.905 0 0 0 8 4zm.002 6a1 1 0 1 0 0 2 1 1 0 0 0 0-2z"/>
                  </svg>
                  最后检查
                </h4>
                <div style="font-size: 16px; font-weight: 600; color: #1f2937;">{{ formatLastChecked(githubStatus.last_checked) }}</div>
              </div>
            </div>
            
            <div v-if="!githubStatus.token_valid && githubStatus.error" style="background: linear-gradient(135deg, rgba(239, 68, 68, 0.1), rgba(220, 38, 38, 0.1)); border-radius: 12px; padding: 1em; border: 1px solid rgba(239, 68, 68, 0.2); margin-top: 1em;">
              <div style="color: #ef4444; font-size: 14px; font-weight: 500; display: flex; align-items: center; gap: 0.5em;">
                <svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
                  <path d="M8.982 1.566a1.13 1.13 0 0 0-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 5.995A.905.905 0 0 1 8 5zm.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"/>
                </svg>
                错误: {{ githubStatus.error }}
              </div>
            </div>
          </div>
        </div>

      <!-- 批量操作 -->
      <div style="background-color: white; border-radius: 8px; border: 1px solid #d0d7de; padding: 1em; margin-bottom: 1.5em;">
        <div style="display: flex; align-items: center; gap: 1em; flex-wrap: wrap; margin-bottom: 1em;">
          <label style="display: flex; align-items: center; gap: 0.5em;">
            <input type="checkbox" v-model="selectAll" @change="toggleSelectAll"> 全选
          </label>
          <label style="display: flex; align-items: center; gap: 0.5em;">
            <input type="checkbox" v-model="showErrorsOnly"> 仅显示错误
          </label>
          <label style="display: flex; align-items: center; gap: 0.5em;">
            筛选时间: 
            <select v-model="timeFilter" style="padding: 5px; border-radius: 4px; border: 1px solid #d0d7de;">
              <option value="">全部</option>
              <option value="1h">1小时内</option>
              <option value="24h">24小时内</option>
              <option value="7d">7天内</option>
              <option value="30d">30天内</option>
            </select>
          </label>
          <span style="color: #656d76; font-size: 14px;">已选择: {{ selectedRepos.length }} / {{ filteredRepositories.length }}</span>
        </div>
        <div style="display: flex; gap: 0.5em;">
          <button @click="manualCheckAll" :disabled="checkingAll" style="background-color: #0969da; color: white; border: 1px solid #0969da; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 14px;" :style="{ opacity: checkingAll ? 0.6 : 1 }">
            <span v-if="checkingAll">⏳ 检测中...</span>
            <span v-else>🔄 检测所有仓库</span>
          </button>
          <button @click="refreshSelected" :disabled="selectedRepos.length === 0" style="background-color: #2da44e; color: white; border: 1px solid #2da44e; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 14px;" :style="{ opacity: selectedRepos.length === 0 ? 0.6 : 1 }">
            刷新选中
          </button>
          <button @click="batchDelete" :disabled="selectedRepos.length === 0" style="background-color: #da3633; color: white; border: 1px solid #da3633; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 14px;" :style="{ opacity: selectedRepos.length === 0 ? 0.6 : 1 }">
            批量删除 ({{ selectedRepos.length }})
          </button>
        </div>
      </div>

      <!-- 错误信息 -->
      <div v-if="error" style="background: #f8d7da; color: #721c24; padding: 15px; border-radius: 8px; margin: 20px 0; border: 1px solid #f5c2c7;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span>❌ {{ error }}</span>
          <button @click="error = null" style="background: none; border: none; color: #721c24; cursor: pointer; font-size: 18px;">×</button>
        </div>
      </div>

      <!-- 加载状态 -->
      <div v-if="isLoading && repositories.length === 0" style="text-align: center; padding: 40px; background: white; border-radius: 8px; border: 1px solid #d0d7de;">
        <div style="display: inline-block; width: 40px; height: 40px; border: 3px solid #f3f3f3; border-top: 3px solid #3498db; border-radius: 50%; animation: spin 1s linear infinite;"></div>
        <p style="margin-top: 1em; color: #656d76;">正在加载仓库数据...</p>
      </div>

      <!-- 仓库列表 -->
      <div v-else-if="filteredRepositories.length > 0" style="background-color: white; border-radius: 8px; border: 1px solid #d0d7de; overflow: hidden;">
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr style="background-color: #f6f8fa;">
              <th style="padding: 12px; text-align: left; border-bottom: 1px solid #d0d7de; font-weight: 600; color: #24292f; width: 40px;">
                <input type="checkbox" :checked="selectAll" @change="toggleSelectAll">
              </th>
              <th style="padding: 12px; text-align: left; border-bottom: 1px solid #d0d7de; font-weight: 600; color: #24292f;">仓库名称</th>
              <th style="padding: 12px; text-align: left; border-bottom: 1px solid #d0d7de; font-weight: 600; color: #24292f;">状态</th>
              <th style="padding: 12px; text-align: left; border-bottom: 1px solid #d0d7de; font-weight: 600; color: #24292f;">最后提交</th>
              <th style="padding: 12px; text-align: left; border-bottom: 1px solid #d0d7de; font-weight: 600; color: #24292f;">提交者</th>
              <th style="padding: 12px; text-align: left; border-bottom: 1px solid #d0d7de; font-weight: 600; color: #24292f;">最后更新</th>
              <th style="padding: 12px; text-align: left; border-bottom: 1px solid #d0d7de; font-weight: 600; color: #24292f; width: 100px;">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="repo in paginatedRepositories" :key="repo.id" :style="{ backgroundColor: selectedRepos.includes(repo.name) ? '#f0f8ff' : 'white' }" @mouseover="$event.target.closest('tr').style.backgroundColor='#f6f8fa'" @mouseout="$event.target.closest('tr').style.backgroundColor = selectedRepos.includes(repo.name) ? '#f0f8ff' : 'white'">
              <td style="padding: 12px; border-bottom: 1px solid #d0d7de;">
                <input type="checkbox" :checked="selectedRepos.includes(repo.name)" @change="toggleRepoSelection(repo.name)">
              </td>
              <td style="padding: 12px; border-bottom: 1px solid #d0d7de;">
                <a :href="'https://github.com/' + repo.name" target="_blank" style="color: #0969da; text-decoration: none; font-weight: 500;">
                  {{ repo.name }}
                </a>
              </td>
              <td style="padding: 12px; border-bottom: 1px solid #d0d7de;">
                <span :style="{ 
                  color: repo.status === 'active' ? '#1a7f37' : repo.status === 'error' ? '#cf222e' : '#bf8700',
                  fontWeight: 'bold',
                  fontSize: '12px',
                  padding: '4px 8px',
                  borderRadius: '12px',
                  backgroundColor: repo.status === 'active' ? '#d4edda' : repo.status === 'error' ? '#f8d7da' : '#fff3cd'
                }">
                  {{ repo.status || 'unknown' }}
                </span>
                <div v-if="repo.error" style="color: #cf222e; font-size: 12px; margin-top: 4px;" :title="repo.error">
                  {{ truncateText(repo.error, 30) }}
                </div>
              </td>
              <td style="padding: 12px; border-bottom: 1px solid #d0d7de;">
                <div v-if="repo.last_commit_sha">
                  <div style="font-family: monospace; color: #0969da; cursor: pointer;" @click="navigator.clipboard?.writeText(repo.last_commit_sha)" :title="'点击复制: ' + repo.last_commit_sha">
                    {{ repo.last_commit_sha.substring(0, 7) }}
                  </div>
                  <div v-if="repo.commit_message" style="color: #656d76; font-size: 12px; margin-top: 2px;" :title="repo.commit_message">
                    {{ truncateText(repo.commit_message, 40) }}
                  </div>
                </div>
                <span v-else style="color: #8c959f;">-</span>
              </td>
              <td style="padding: 12px; border-bottom: 1px solid #d0d7de;">
                <span v-if="repo.committer">{{ repo.committer }}</span>
                <span v-else style="color: #8c959f;">-</span>
              </td>
              <td style="padding: 12px; border-bottom: 1px solid #d0d7de;">
                <span :title="new Date(repo.last_update).toLocaleString()">
                  {{ formatTimeAgo(repo.last_update) }}
                </span>
              </td>
              <td style="padding: 12px; border-bottom: 1px solid #d0d7de;">
                <button @click="manualCheckRepository(repo.name)" :disabled="checkingRepos.includes(repo.name)" style="background: none; border: none; cursor: pointer; padding: 4px; margin-right: 4px; font-size: 16px;" title="手动检测">
                  <span v-if="checkingRepos.includes(repo.name)">⏳</span>
                  <span v-else>🔄</span>
                </button>
                <button @click="refreshRepository(repo.name)" style="background: none; border: none; cursor: pointer; padding: 4px; margin-right: 4px; font-size: 16px;" title="刷新">
                  🔁
                </button>
                <button @click="deleteRepository(repo.name)" style="background: none; border: none; cursor: pointer; padding: 4px; font-size: 16px;" title="删除">
                  🗑️
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        
        <!-- 分页信息和控件 -->
        <div v-if="totalPages > 1" style="padding: 1.5em 2em; border-top: 1px solid #d0d7de; background: #f6f8fa; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1em;">
          <div style="display: flex; align-items: center; gap: 1.5em; flex-wrap: wrap;">
            <!-- 分页信息 -->
            <div style="color: #656d76; font-size: 14px;">
              显示第 {{ ((currentPage - 1) * (pageSize === 'custom' ? customPageSize : parseInt(pageSize))) + 1 }} - {{ Math.min(currentPage * (pageSize === 'custom' ? customPageSize : parseInt(pageSize)), filteredRepositories.length) }} 项，共 {{ filteredRepositories.length }} 项
            </div>
            
            <!-- 每页显示数量选择器 -->
            <div style="display: flex; align-items: center; gap: 0.5em;">
              <label style="font-size: 14px; color: #656d76;">每页:</label>
              <select v-model="pageSize" @change="resetPagination" style="padding: 6px 10px; border-radius: 6px; border: 1px solid #d0d7de; font-size: 14px; background: white; cursor: pointer; transition: all 0.3s ease;">
                <option value="10">10 条</option>
                <option value="25">25 条</option>
                <option value="50">50 条</option>
                <option value="custom">自定义</option>
              </select>
              
              <!-- 自定义数量输入 -->
              <div v-if="pageSize === 'custom'" style="display: flex; align-items: center; gap: 0.5em;">
                <input type="number" v-model.number="customPageSize" @keydown.enter="applyCustomPageSize" 
                  min="1" max="1000" placeholder="输入数量"
                  style="width: 80px; padding: 6px 8px; border-radius: 4px; border: 1px solid #d0d7de; text-align: center; font-size: 14px;">
                <button @click="applyCustomPageSize" 
                  style="padding: 6px 12px; border-radius: 4px; border: 1px solid #d0d7de; background: white; cursor: pointer; font-size: 12px; color: #0969da;">
                  应用
                </button>
              </div>
            </div>
          </div>
          
          <div style="display: flex; align-items: center; gap: 0.5em;">
            <!-- 分页控件 -->
            <button @click="previousPage" :disabled="currentPage === 1" 
              style="padding: 8px 12px; border-radius: 6px; border: 1px solid #d0d7de; background: white; cursor: pointer; font-size: 14px; display: flex; align-items: center; gap: 0.5em;" 
              :style="{ opacity: currentPage === 1 ? 0.5 : 1, cursor: currentPage === 1 ? 'not-allowed' : 'pointer' }">
              <svg width="14" height="14" fill="currentColor" viewBox="0 0 16 16">
                <path fill-rule="evenodd" d="M11.354 1.646a.5.5 0 0 1 0 .708L5.707 8l5.647 5.646a.5.5 0 0 1-.708.708l-6-6a.5.5 0 0 1 0-.708l6-6a.5.5 0 0 1 .708 0z"/>
              </svg>
              上一页
            </button>
            
            <!-- 页码显示 -->
            <div style="display: flex; gap: 0.25em; margin: 0 1em;">
              <button v-for="page in Array.from({length: Math.min(5, totalPages)}, (_, i) => {
                const start = Math.max(1, currentPage - 2);
                return start + i;
              }).filter(p => p <= totalPages)" 
                :key="page"
                @click="goToPage(page)"
                :style="{
                  padding: '8px 12px',
                  borderRadius: '6px',
                  border: '1px solid',
                  background: page === currentPage ? '#0969da' : 'white',
                  color: page === currentPage ? 'white' : '#24292f',
                  borderColor: page === currentPage ? '#0969da' : '#d0d7de',
                  cursor: 'pointer',
                  fontSize: '14px',
                  fontWeight: page === currentPage ? '600' : '400'
                }">
                {{ page }}
              </button>
            </div>
            
            <button @click="nextPage" :disabled="currentPage === totalPages" 
              style="padding: 8px 12px; border-radius: 6px; border: 1px solid #d0d7de; background: white; cursor: pointer; font-size: 14px; display: flex; align-items: center; gap: 0.5em;" 
              :style="{ opacity: currentPage === totalPages ? 0.5 : 1, cursor: currentPage === totalPages ? 'not-allowed' : 'pointer' }">
              下一页
              <svg width="14" height="14" fill="currentColor" viewBox="0 0 16 16">
                <path fill-rule="evenodd" d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708z"/>
              </svg>
            </button>
            
            <!-- 快速跳转 -->
            <div style="display: flex; align-items: center; gap: 0.5em; margin-left: 1em; color: #656d76; font-size: 14px;">
              <span>跳转到:</span>
              <input type="number" v-model.number="currentPage" @change="goToPage(currentPage)" :min="1" :max="totalPages"
                style="width: 60px; padding: 4px 8px; border-radius: 4px; border: 1px solid #d0d7de; text-align: center; font-size: 14px;">
            </div>
          </div>
        </div>
      </div>
      
      <!-- 空状态 -->
      <div v-else style="text-align: center; padding: 40px; color: #6c757d; background: white; border-radius: 8px; border: 1px solid #d0d7de;">
        <p style="font-size: 18px;">📂 {{ showErrorsOnly ? '没有错误的仓库' : '暂无仓库数据' }}</p>
        <p style="font-size: 14px;">{{ showErrorsOnly ? '所有仓库状态正常' : '请先添加一些仓库进行监控' }}</p>
      </div>
      
      <!-- 配置模态框 -->
      <div v-if="showConfigModal" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000;" @click.self="showConfigModal = false">
        <div style="background-color: white; border-radius: 8px; padding: 2em; max-width: 500px; width: 90%; max-height: 80vh; overflow-y: auto;">
          <h3 style="margin-top: 0; color: #24292f;">系统配置</h3>
          <div style="display: flex; flex-direction: column; gap: 1em;">
            <div style="display: flex; flex-direction: column; gap: 0.5em;">
              <label style="font-weight: 600; color: #24292f;">GitHub Token</label>
              <input type="password" v-model="config.githubToken" placeholder="输入新的GitHub Token..." style="padding: 10px; border-radius: 6px; border: 1px solid #d0d7de;">
              <div style="font-size: 12px; color: #57606a;">{{ config.hasToken ? '已配置Token (留空保持不变)' : '未配置Token' }}</div>
            </div>
            <div style="display: flex; flex-direction: column; gap: 0.5em;">
              <label style="font-weight: 600; color: #24292f;">更新频率 (分钟)</label>
              <input type="number" v-model="config.updateInterval" min="1" max="1440" style="padding: 10px; border-radius: 6px; border: 1px solid #d0d7de;">
              <div style="font-size: 12px; color: #57606a;">仓库状态自动更新的时间间隔</div>
            </div>
            <div style="display: flex; flex-direction: column; gap: 0.5em;">
              <label style="font-weight: 600; color: #24292f;">初始延迟 (秒)</label>
              <input type="number" v-model="config.initialDelay" min="0" max="300" style="padding: 10px; border-radius: 6px; border: 1px solid #d0d7de;">
              <div style="font-size: 12px; color: #57606a;">系统启动后首次更新的延迟时间</div>
            </div>
            <div style="display: flex; flex-direction: column; gap: 0.5em;">
              <label style="font-weight: 600; color: #24292f;">最大并发请求数</label>
              <input type="number" v-model="config.maxConcurrentRequests" min="1" max="10" style="padding: 10px; border-radius: 6px; border: 1px solid #d0d7de;">
              <div style="font-size: 12px; color: #57606a;">同时向GitHub API发送的最大请求数</div>
            </div>
            <div style="display: flex; flex-direction: column; gap: 0.5em;">
              <label style="font-weight: 600; color: #24292f;">请求延迟 (毫秒)</label>
              <input type="number" v-model="config.requestDelay" min="100" max="5000" step="100" style="padding: 10px; border-radius: 6px; border: 1px solid #d0d7de;">
              <div style="font-size: 12px; color: #57606a;">两次API请求之间的延迟时间</div>
            </div>
          </div>
          <div style="display: flex; justify-content: flex-end; gap: 1em; margin-top: 1em;">
            <button @click="showConfigModal = false" style="background-color: #f6f8fa; color: #24292f; padding: 10px 20px; border: 1px solid #d0d7de; border-radius: 6px; cursor: pointer;">取消</button>
            <button @click="saveConfig" style="background-color: #2da44e; color: white; font-weight: 600; border: 1px solid #2da44e; padding: 10px 20px; border-radius: 6px; cursor: pointer;">保存配置</button>
          </div>
        </div>
      </div>
    </div>
    </div>
  `
};
