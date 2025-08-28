package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/go-github/v63/github"
	"golang.org/x/oauth2"
	"github.com/glebarez/sqlite" 
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	
	applogger "github.com/s1g0day/github-monitor/internal/logger"
)

type Config struct {
	GitHubToken string `json:"github_token"`
	UpdateInterval int `json:"update_interval"` // 更新频率，单位：分钟
	InitialDelay int `json:"initial_delay"` // 初始延迟，单位：秒
	MaxConcurrentRequests int `json:"max_concurrent_requests"` // 最大并发请求数
	RequestDelay int `json:"request_delay"` // 请求延迟，单位：毫秒
}

// AppConfig 持久化到数据库的系统配置（单行记录）
type AppConfig struct {
	ID                    uint      `gorm:"primaryKey"`
	CreatedAt             time.Time `json:"-"`
	UpdatedAt             time.Time `json:"-"`
	GitHubToken           string    `json:"github_token"`
	UpdateInterval        int       `json:"update_interval"`
	InitialDelay          int       `json:"initial_delay"`
	MaxConcurrentRequests int       `json:"max_concurrent_requests"`
	RequestDelay          int       `json:"request_delay"`
}

type RepoStatus struct {
	ID            uint      `json:"id" gorm:"primaryKey"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
	Name          string    `json:"name" gorm:"uniqueIndex"`
	Status        string    `json:"status"`        // pending, active, error
	LastCommitSHA string    `json:"last_commit_sha"`
	LastUpdate    time.Time `json:"last_update"`
	CommitMessage string    `json:"commit_message"`
	Committer     string    `json:"committer"`
	Error         string    `json:"error,omitempty"`
}

// GitHub API状态信息
type GitHubAPIStatus struct {
	TokenValid      bool      `json:"token_valid"`
	Username        string    `json:"username,omitempty"`
	RateLimit       RateLimit `json:"rate_limit"`
	LastChecked     time.Time `json:"last_checked"`
	Error           string    `json:"error,omitempty"`
	Permissions     []string  `json:"permissions,omitempty"`
	TokenType       string    `json:"token_type,omitempty"` // classic, fine-grained
	ExpiresAt       *time.Time `json:"expires_at,omitempty"`
}

type RateLimit struct {
	Limit     int       `json:"limit"`
	Used      int       `json:"used"`
	Remaining int       `json:"remaining"`
	ResetTime time.Time `json:"reset_time"`
}

var (
	config       Config
	db           *gorm.DB
	githubClient *github.Client
	initialCheckComplete bool = false
	githubAPIStatus GitHubAPIStatus
	statusMutex sync.RWMutex
)

// Rate limiter for GitHub API requests
var (
	rateLimiter chan struct{}
	requestDelay time.Duration
)

// Background task queue for repository processing
type RepoTask struct {
	RepoName string
	Action   string // "fetch", "update"
}

var (
	taskQueue = make(chan RepoTask, 1000)
	queueInitialized = false
)

func initializeDB() {
	var err error
	
	config := &gorm.Config{
		Logger: logger.Default.LogMode(logger.Error),
		DisableForeignKeyConstraintWhenMigrating: true,
	}
	
	db, err = gorm.Open(sqlite.Open("gorm.db"), config)
	if err != nil {
		applogger.Fatal("DATABASE", err, "Failed to connect to database")
	}

	// 异步设置连接池参数，不阻塞启动
	go func() {
		sqlDB, err := db.DB()
		if err != nil {
			applogger.Error("DATABASE", err, "Failed to configure connection pool")
			return
		}
		
		sqlDB.SetMaxIdleConns(5)
		sqlDB.SetMaxOpenConns(25)
		sqlDB.SetConnMaxLifetime(30 * time.Minute)
		applogger.Debug("DATABASE", "Connection pool configured", map[string]interface{}{
			"max_idle": 5,
			"max_open": 25,
			"max_lifetime": "30m",
		})
	}()

	// 执行数据库迁移
	if err := db.AutoMigrate(&RepoStatus{}, &AppConfig{}); err != nil {
		applogger.Error("DATABASE", err, "Database migration failed")
	} else {
		applogger.Debug("DATABASE", "Database migration completed", nil)
	}
	
	applogger.Info("DATABASE", "Database initialized successfully", nil)
}

// 从数据库读取配置；若不存在则初始化默认值或从旧的 config.json 迁移
func loadConfig() {
	// 若存在旧文件则尝试迁移一次
	migrateConfigFromFileIfPresent()

	var appCfg AppConfig
	if err := db.First(&appCfg, 1).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			// 初始化默认配置
			appCfg = AppConfig{
				ID:                     1,
				UpdateInterval:        10,
				InitialDelay:          0,
				MaxConcurrentRequests: 3,
				RequestDelay:          1000,
			}
			if err := db.Create(&appCfg).Error; err != nil {
				applogger.Fatal("CONFIG", err, "Failed to create default config in database")
			}
		} else {
			applogger.Fatal("CONFIG", err, "Failed to load configuration from database")
		}
	}

	// 映射到全局运行时配置
	config = Config{
		GitHubToken:           appCfg.GitHubToken,
		UpdateInterval:        appCfg.UpdateInterval,
		InitialDelay:          appCfg.InitialDelay,
		MaxConcurrentRequests: appCfg.MaxConcurrentRequests,
		RequestDelay:          appCfg.RequestDelay,
	}

	// 再次确保默认值
	if config.UpdateInterval <= 0 {
		config.UpdateInterval = 10
	}
	if config.MaxConcurrentRequests <= 0 {
		config.MaxConcurrentRequests = 3
	}
	if config.RequestDelay <= 0 {
		config.RequestDelay = 1000
	}

	applogger.Info("CONFIG", "Configuration loaded from database successfully", nil)
}

// 保存当前内存配置到数据库（单行 Upsert）
func saveConfigToDB() error {
	var appCfg AppConfig
	err := db.First(&appCfg, 1).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		appCfg = AppConfig{ID: 1}
	} else if err != nil {
		return err
	}

	appCfg.GitHubToken = config.GitHubToken
	appCfg.UpdateInterval = config.UpdateInterval
	appCfg.InitialDelay = config.InitialDelay
	appCfg.MaxConcurrentRequests = config.MaxConcurrentRequests
	appCfg.RequestDelay = config.RequestDelay

	if appCfg.ID == 0 {
		return db.Create(&appCfg).Error
	}
	return db.Save(&appCfg).Error
}

// 如存在旧的 config.json，则迁移到数据库并删除文件
func migrateConfigFromFileIfPresent() {
	if _, err := os.Stat("config.json"); err == nil {
		content, err := os.ReadFile("config.json")
		if err == nil {
			var fileCfg Config
			if json.Unmarshal(content, &fileCfg) == nil {
				// 暂存原内存值，将文件配置写入数据库
				tmp := config
				config = fileCfg
				if err := saveConfigToDB(); err != nil {
					applogger.Warn("CONFIG", "Failed to migrate config.json to DB", map[string]interface{}{"error": err.Error()})
				} else {
					applogger.Info("CONFIG", "Migrated config.json to database", nil)
					if remErr := os.Remove("config.json"); remErr != nil {
						applogger.Warn("CONFIG", "Failed to remove legacy config.json", map[string]interface{}{"error": remErr.Error()})
					} else {
						applogger.Info("CONFIG", "Removed legacy config.json", nil)
					}
				}
				config = tmp
			}
		}
	}
}

func initializeGitHubClient() {
	ctx := context.Background()
	ts := oauth2.StaticTokenSource(
		&oauth2.Token{AccessToken: config.GitHubToken},
	)
	tc := oauth2.NewClient(ctx, ts)
	tc.Timeout = 30 * time.Second
	
	githubClient = github.NewClient(tc)
	
	// 初始化rate limiter
	maxRequests := 3 // 默认值
	if config.MaxConcurrentRequests > 0 {
		maxRequests = config.MaxConcurrentRequests
	}
	rateLimiter = make(chan struct{}, maxRequests)
	
	// 初始化请求延迟
	delay := 1000 // 默认1秒 (1000毫秒)
	if config.RequestDelay > 0 {
		delay = config.RequestDelay
	}
	requestDelay = time.Duration(delay) * time.Millisecond
	
	applogger.Info("GITHUB", "GitHub API client initialized", map[string]interface{}{
		"timeout": "30s",
		"max_requests": maxRequests,
		"request_delay": delay,
	})
	
	// 检查GitHub API状态
	go func() {
		applogger.Info("GITHUB", "Checking GitHub API status...", nil)
		status := checkGitHubAPIStatus()
		if status.TokenValid {
			applogger.Info("GITHUB", "GitHub API status check successful", map[string]interface{}{
				"username": status.Username,
				"token_type": status.TokenType,
				"rate_limit_remaining": status.RateLimit.Remaining,
				"permissions": status.Permissions,
			})
		} else {
			applogger.Error("GITHUB", fmt.Errorf(status.Error), "GitHub API status check failed")
		}
	}()
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func getRepoStatus(owner, repo string) RepoStatus {
	repoFullName := fmt.Sprintf("%s/%s", owner, repo)
	
	rateLimiter <- struct{}{}
	defer func() { 
		time.Sleep(requestDelay)
		<-rateLimiter 
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	commits, _, err := githubClient.Repositories.ListCommits(ctx, owner, repo, &github.CommitsListOptions{
		ListOptions: github.ListOptions{PerPage: 1},
	})
	
	if err != nil {
		applogger.ErrorWithData("GITHUB_API", err, "Failed to fetch repository commits", map[string]interface{}{
			"repository": repoFullName,
		})
		return RepoStatus{Name: repoFullName, Error: err.Error(), Status: "error"}
	}
	
	if len(commits) == 0 {
		applogger.Warn("GITHUB_API", "No commits found in repository", map[string]interface{}{
			"repository": repoFullName,
		})
		return RepoStatus{Name: repoFullName, Error: "No commits found", Status: "error"}
	}
	
	latestCommit := commits[0]
	
	commitSHA := ""
	if latestCommit.SHA != nil {
		commitSHA = *latestCommit.SHA
	}
	
	commitMessage := ""
	if latestCommit.GetCommit().Message != nil {
		commitMessage = *latestCommit.GetCommit().Message
	}
	
	committerName := ""
	if latestCommit.GetCommit().GetAuthor().Name != nil {
		committerName = *latestCommit.GetCommit().GetAuthor().Name
	}
	
	commitDate := time.Now()
	if !latestCommit.GetCommit().GetAuthor().GetDate().Time.IsZero() {
		commitDate = latestCommit.GetCommit().GetAuthor().GetDate().Time
	}
	
	return RepoStatus{
		Name:          repoFullName,
		LastCommitSHA: commitSHA,
		LastUpdate:    commitDate,
		CommitMessage: commitMessage,
		Committer:     committerName,
		Status:        "active",
	}
}

// 后台任务处理器
func startBackgroundProcessor() {
	if queueInitialized {
		return
	}
	queueInitialized = true
	
	applogger.Info("BACKGROUND", "Starting background task processor", nil)
	
	// 启动多个worker处理任务
	workerCount := 3
	if config.MaxConcurrentRequests > 0 {
		workerCount = config.MaxConcurrentRequests
	}
	
	for i := 0; i < workerCount; i++ {
		go func(workerID int) {
			applogger.Debug("BACKGROUND", "Starting background worker", map[string]interface{}{
				"worker_id": workerID,
			})
			
			for task := range taskQueue {
				processRepoTask(task, workerID)
			}
		}(i)
	}
}

// 处理单个仓库任务
func processRepoTask(task RepoTask, workerID int) {
	applogger.Debug("BACKGROUND", "Processing repository task", map[string]interface{}{
		"repository": task.RepoName,
		"action": task.Action,
		"worker_id": workerID,
	})
	
	parts := strings.Split(task.RepoName, "/")
	if len(parts) != 2 {
		applogger.Warn("BACKGROUND", "Invalid repository format in task", map[string]interface{}{
			"repository": task.RepoName,
			"worker_id": workerID,
		})
		// 更新状态为错误
		db.Model(&RepoStatus{}).Where("name = ?", task.RepoName).Updates(map[string]interface{}{
			"status": "error",
			"error": "Invalid repository format",
			"updated_at": time.Now(),
		})
		return
	}
	
	// 获取仓库状态
	status := getRepoStatus(parts[0], parts[1])
	
	// 更新数据库
	updates := map[string]interface{}{
		"status": status.Status,
		"last_commit_sha": status.LastCommitSHA,
		"last_update": status.LastUpdate,
		"commit_message": status.CommitMessage,
		"committer": status.Committer,
		"error": status.Error,
		"updated_at": time.Now(),
	}
	
	if err := db.Model(&RepoStatus{}).Where("name = ?", task.RepoName).Updates(updates).Error; err != nil {
		applogger.ErrorWithData("BACKGROUND", err, "Failed to update repository status in background task", map[string]interface{}{
			"repository": task.RepoName,
			"worker_id": workerID,
		})
		return
	}
	
	if status.Error == "" {
		applogger.Info("BACKGROUND", "Repository processed successfully", map[string]interface{}{
			"repository": task.RepoName,
			"last_commit": status.LastCommitSHA,
			"worker_id": workerID,
		})
	} else {
		applogger.Warn("BACKGROUND", "Repository processed with error", map[string]interface{}{
			"repository": task.RepoName,
			"error": status.Error,
			"worker_id": workerID,
		})
	}
}

func updateAllStatuses() {
	logger := applogger.NewRequestLogger("REPO_UPDATE")
	
	var statuses []RepoStatus
	if err := db.Find(&statuses).Error; err != nil {
		logger.Error(err, "Failed to get repositories from database", nil)
		return
	}
	
	if len(statuses) == 0 {
		applogger.Debug("REPO_UPDATE", "No repositories to update", nil)
		return
	}

	applogger.Info("REPO_UPDATE", "Starting repository status update", map[string]interface{}{
		"repository_count": len(statuses),
	})

	batchSize := 3
	for i := 0; i < len(statuses); i += batchSize {
		end := i + batchSize
		if end > len(statuses) {
			end = len(statuses)
		}

		var wg sync.WaitGroup
		for j := i; j < end; j++ {
			wg.Add(1)
			go func(s RepoStatus) {
				defer wg.Done()
				
				parts := strings.Split(s.Name, "/")
				if len(parts) != 2 {
					applogger.Warn("REPO_UPDATE", "Invalid repository format", map[string]interface{}{
						"repository": s.Name,
					})
					return
				}
				
				status := getRepoStatus(parts[0], parts[1])
				db.Model(&RepoStatus{}).Where("name = ?", status.Name).Updates(status)

			}(statuses[j])
		}
		wg.Wait()
		
		if end < len(statuses) {
			time.Sleep(2 * time.Second)
		}
	}
	
	logger.Success("Repository update completed", map[string]interface{}{
		"processed_count": len(statuses),
	})
}

func statusHandler(c *gin.Context) {
	logger := applogger.NewRequestLogger("API")
	applogger.Debug("API", "Handling status request", map[string]interface{}{
		"path": "/api/status",
	})
	
	// 支持按状态过滤
	status := c.Query("status")
	
	var statuses []RepoStatus
	query := db.Order("last_update desc")
	
	if status != "" {
		query = query.Where("status = ?", status)
	}
	
	if err := query.Find(&statuses).Error; err != nil {
		logger.Error(err, "Failed to fetch repository statuses", nil)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error"})
		return
	}

	applogger.Debug("API", "Successfully fetched repository statuses", map[string]interface{}{
		"count": len(statuses),
		"filter_status": status,
	})
	c.JSON(http.StatusOK, statuses)
}

func addRepositoryHandler(c *gin.Context) {
	logger := applogger.NewRequestLogger("API")
	applogger.Debug("API", "Handling add repository request", nil)
	
	var req struct {
		Name string `json:"name" binding:"required"`
	}
	
	if err := c.ShouldBindJSON(&req); err != nil {
		applogger.Warn("API", "Invalid add repository request", map[string]interface{}{
			"error": err.Error(),
		})
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request"})
		return
	}

	repoFullName := strings.TrimSuffix(req.Name, "/")
	applogger.Debug("API", "Processing repository name", map[string]interface{}{
		"repository": repoFullName,
	})
	
	parts := strings.Split(repoFullName, "/")
	if len(parts) != 2 {
		// 使用专门的仓库失败日志
		applogger.LogRepositoryFailure(repoFullName, "Invalid repository format", nil, map[string]interface{}{
			"client_ip": c.ClientIP(),
			"expected_format": "owner/repo",
		})
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid repository format. Use 'owner/repo'"})
		return
	}

	var existingStatus RepoStatus
	// 检查记录是否已存在
	err := db.First(&existingStatus, "name = ?", repoFullName).Error
	if err == nil {
		// Repository already exists
		applogger.Warn("API", "Repository already exists", map[string]interface{}{
			"repository": repoFullName,
		})
		c.JSON(http.StatusConflict, gin.H{"error": "Repository already exists"})
		return
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		// Database error (not "record not found")
		logger.Error(err, "Failed to check existing repository", map[string]interface{}{
			"repository": repoFullName,
		})
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error"})
		return
	}
	// Repository doesn't exist, continue with adding it

	applogger.Debug("API", "Fetching repository status", map[string]interface{}{
		"owner": parts[0],
		"repo": parts[1],
	})
	status := getRepoStatus(parts[0], parts[1])
	if status.Error != "" {
		// 使用专门的仓库失败日志
		applogger.LogRepositoryFailure(repoFullName, "GitHub API error", fmt.Errorf(status.Error), map[string]interface{}{
			"owner": parts[0],
			"repo": parts[1],
			"client_ip": c.ClientIP(),
		})
		c.JSON(http.StatusBadRequest, gin.H{"error": "Failed to fetch repository: " + status.Error})
		return
	}

	applogger.Debug("API", "Saving repository to database", map[string]interface{}{
		"repository": repoFullName,
		"last_commit": status.LastCommitSHA,
	})
	if err := db.Create(&status).Error; err != nil {
		// 使用专门的仓库失败日志
		applogger.LogRepositoryFailure(repoFullName, "Database error", err, map[string]interface{}{
			"owner": parts[0],
			"repo": parts[1],
			"client_ip": c.ClientIP(),
			"last_commit": status.LastCommitSHA,
		})
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error"})
		return
	}

	logger.Success("Repository added successfully", map[string]interface{}{
		"repository": repoFullName,
		"last_commit": status.LastCommitSHA,
	})
	c.JSON(http.StatusCreated, status)
}

// 快速添加仓库API - 立即返回，后台处理
func quickAddRepositoryHandler(c *gin.Context) {
	logger := applogger.NewRequestLogger("API")
	applogger.Debug("API", "Handling quick add repository request", nil)
	
	var req struct {
		Name string `json:"name" binding:"required"`
	}
	
	if err := c.ShouldBindJSON(&req); err != nil {
		applogger.Warn("API", "Invalid quick add repository request", map[string]interface{}{
			"error": err.Error(),
		})
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request"})
		return
	}

	repoFullName := strings.TrimSuffix(req.Name, "/")
	applogger.Debug("API", "Processing quick add repository name", map[string]interface{}{
		"repository": repoFullName,
	})
	
	parts := strings.Split(repoFullName, "/")
	if len(parts) != 2 {
		// 使用专门的仓库失败日志
		applogger.LogRepositoryFailure(repoFullName, "Invalid repository format", nil, map[string]interface{}{
			"client_ip": c.ClientIP(),
			"expected_format": "owner/repo",
		})
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid repository format. Use 'owner/repo'"})
		return
	}

	var existingStatus RepoStatus
	// 检查记录是否已存在
	err := db.First(&existingStatus, "name = ?", repoFullName).Error
	if err == nil {
		// Repository already exists
		applogger.Warn("API", "Repository already exists", map[string]interface{}{
			"repository": repoFullName,
		})
		c.JSON(http.StatusConflict, gin.H{"error": "Repository already exists"})
		return
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		// Database error (not "record not found")
		logger.Error(err, "Failed to check existing repository", map[string]interface{}{
			"repository": repoFullName,
		})
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error"})
		return
	}

	// 创建pending状态的记录
	pendingRepo := RepoStatus{
		Name:       repoFullName,
		Status:     "pending",
		LastUpdate: time.Now(),
	}

	applogger.Debug("API", "Creating pending repository record", map[string]interface{}{
		"repository": repoFullName,
	})
	
	if err := db.Create(&pendingRepo).Error; err != nil {
		// 使用专门的仓库失败日志
		applogger.LogRepositoryFailure(repoFullName, "Database error", err, map[string]interface{}{
			"owner": parts[0],
			"repo": parts[1],
			"client_ip": c.ClientIP(),
		})
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error"})
		return
	}

	// 将任务添加到后台队列
	select {
	case taskQueue <- RepoTask{RepoName: repoFullName, Action: "fetch"}:
		applogger.Debug("API", "Repository task queued for background processing", map[string]interface{}{
			"repository": repoFullName,
		})
	default:
		applogger.Warn("API", "Task queue is full, repository will be processed later", map[string]interface{}{
			"repository": repoFullName,
		})
	}

	logger.Success("Repository queued for processing", map[string]interface{}{
		"repository": repoFullName,
		"status": "pending",
	})
	
	c.JSON(http.StatusCreated, gin.H{
		"message": "Repository added successfully and queued for processing",
		"repository": pendingRepo,
		"status": "pending",
	})
}

// 批量快速添加仓库API
func batchQuickAddRepositoryHandler(c *gin.Context) {
	logger := applogger.NewRequestLogger("API")
	applogger.Debug("API", "Handling batch quick add repositories request", nil)
	
	var req struct {
		Names []string `json:"names" binding:"required"`
	}
	
	if err := c.ShouldBindJSON(&req); err != nil {
		applogger.Warn("API", "Invalid batch quick add request", map[string]interface{}{
			"error": err.Error(),
		})
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request"})
		return
	}

	if len(req.Names) == 0 {
		applogger.Warn("API", "Empty repository list for batch quick add", nil)
		c.JSON(http.StatusBadRequest, gin.H{"error": "No repositories specified"})
		return
	}

	applogger.Info("API", "Processing batch quick add", map[string]interface{}{
		"repository_count": len(req.Names),
	})

	var successRepos []RepoStatus
	var failedRepos []string
	var duplicateRepos []string

	for _, name := range req.Names {
		repoFullName := strings.TrimSuffix(name, "/")
		
		// 格式验证
		parts := strings.Split(repoFullName, "/")
		if len(parts) != 2 {
			failedRepos = append(failedRepos, fmt.Sprintf("%s: invalid format", repoFullName))
			continue
		}

		// 检查是否已存在
		var existingStatus RepoStatus
		err := db.First(&existingStatus, "name = ?", repoFullName).Error
		if err == nil {
			duplicateRepos = append(duplicateRepos, repoFullName)
			continue
		} else if !errors.Is(err, gorm.ErrRecordNotFound) {
			failedRepos = append(failedRepos, fmt.Sprintf("%s: database error", repoFullName))
			continue
		}

		// 创建pending记录
		pendingRepo := RepoStatus{
			Name:       repoFullName,
			Status:     "pending",
			LastUpdate: time.Now(),
		}

		if err := db.Create(&pendingRepo).Error; err != nil {
			failedRepos = append(failedRepos, fmt.Sprintf("%s: create failed", repoFullName))
			continue
		}

		successRepos = append(successRepos, pendingRepo)

		// 添加到后台队列
		select {
		case taskQueue <- RepoTask{RepoName: repoFullName, Action: "fetch"}:
			// 任务成功加入队列
		default:
			applogger.Warn("API", "Task queue full for repository", map[string]interface{}{
				"repository": repoFullName,
			})
		}
	}

	logger.Success("Batch quick add completed", map[string]interface{}{
		"total_count": len(req.Names),
		"success_count": len(successRepos),
		"failed_count": len(failedRepos),
		"duplicate_count": len(duplicateRepos),
	})

	response := gin.H{
		"message": "Batch add completed",
		"total": len(req.Names),
		"success": len(successRepos),
		"failed": len(failedRepos),
		"duplicate": len(duplicateRepos),
		"added_repositories": successRepos,
	}

	if len(failedRepos) > 0 {
		response["failures"] = failedRepos
	}
	if len(duplicateRepos) > 0 {
		response["duplicates"] = duplicateRepos
	}

	c.JSON(http.StatusOK, response)
}

// 获取队列状态API
func getQueueStatusHandler(c *gin.Context) {
	applogger.Debug("API", "Handling queue status request", nil)
	
	// 获取pending状态的仓库数量
	var pendingCount int64
	db.Model(&RepoStatus{}).Where("status = ?", "pending").Count(&pendingCount)
	
	// 获取错误状态的仓库数量
	var errorCount int64
	db.Model(&RepoStatus{}).Where("status = ?", "error").Count(&errorCount)
	
	// 获取活跃状态的仓库数量
	var activeCount int64
	db.Model(&RepoStatus{}).Where("status = ?", "active").Count(&activeCount)
	
	queueLen := len(taskQueue)
	
	c.JSON(http.StatusOK, gin.H{
		"queue_length": queueLen,
		"pending_count": pendingCount,
		"active_count": activeCount,
		"error_count": errorCount,
		"total_repositories": pendingCount + activeCount + errorCount,
	})
}

// 获取pending状态的仓库列表
func getPendingRepositoriesHandler(c *gin.Context) {
	logger := applogger.NewRequestLogger("API")
	applogger.Debug("API", "Handling pending repositories request", nil)
	
	var pendingRepos []RepoStatus
	if err := db.Where("status = ?", "pending").Order("created_at desc").Find(&pendingRepos).Error; err != nil {
		logger.Error(err, "Failed to fetch pending repositories", nil)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error"})
		return
	}
	
	c.JSON(http.StatusOK, gin.H{
		"pending_repositories": pendingRepos,
		"count": len(pendingRepos),
	})
}

func deleteRepositoryHandler(c *gin.Context) {
	logger := applogger.NewRequestLogger("API")
	
	owner := c.Param("owner")
	repo := c.Param("repo")
	fullName := fmt.Sprintf("%s/%s", owner, repo)
	
	applogger.Debug("API", "Handling delete repository request", map[string]interface{}{
		"repository": fullName,
		"owner": owner,
		"repo": repo,
	})

	// 先检查仓库是否存在
	var existingRepo RepoStatus
	if err := db.Where("name = ?", fullName).First(&existingRepo).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			applogger.Warn("API", "Repository not found for deletion", map[string]interface{}{
				"repository": fullName,
			})
			c.JSON(http.StatusNotFound, gin.H{"error": "Repository not found"})
			return
		} else {
			logger.Error(err, "Failed to check repository existence", map[string]interface{}{
				"repository": fullName,
			})
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error"})
			return
		}
	}

	applogger.Info("API", "Found repository for deletion", map[string]interface{}{
		"repository": fullName,
		"id": existingRepo.ID,
	})

	// 执行删除操作
	result := db.Where("name = ?", fullName).Delete(&RepoStatus{})
	if result.Error != nil {
		logger.Error(result.Error, "Failed to delete repository from database", map[string]interface{}{
			"repository": fullName,
		})
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error"})
		return
	}

	applogger.Info("API", "Delete operation completed", map[string]interface{}{
		"repository": fullName,
		"rows_affected": result.RowsAffected,
	})

	if result.RowsAffected == 0 {
		applogger.Warn("API", "No rows affected during deletion", map[string]interface{}{
			"repository": fullName,
		})
		c.JSON(http.StatusNotFound, gin.H{"error": "Repository not found"})
		return
	}

	logger.Success("Repository deleted successfully", map[string]interface{}{
		"repository": fullName,
		"rows_affected": result.RowsAffected,
	})
	c.JSON(http.StatusOK, gin.H{"message": "Repository deleted successfully"})
}

// 调试端点：查看所有记录
func debugAllRepositoriesHandler(c *gin.Context) {
	logger := applogger.NewRequestLogger("API")
	applogger.Debug("API", "Handling debug all repositories request", nil)
	
	var allStatuses []RepoStatus
	if err := db.Order("created_at desc").Find(&allStatuses).Error; err != nil {
		logger.Error(err, "Failed to fetch all repository statuses", nil)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error"})
		return
	}
	
	result := make([]map[string]interface{}, len(allStatuses))
	for i, status := range allStatuses {
		result[i] = map[string]interface{}{
			"id": status.ID,
			"name": status.Name,
			"created_at": status.CreatedAt,
			"updated_at": status.UpdatedAt,
			"last_commit_sha": status.LastCommitSHA,
			"last_update": status.LastUpdate,
		}
	}
	
	applogger.Info("API", "Debug: Fetched all repositories", map[string]interface{}{
		"total_count": len(allStatuses),
	})
	c.JSON(http.StatusOK, gin.H{
		"total_count": len(allStatuses),
		"repositories": result,
	})
}
func batchDeleteHandler(c *gin.Context) {
	logger := applogger.NewRequestLogger("API")
	applogger.Debug("API", "Handling batch delete request", nil)
	
	var req struct {
		Names []string `json:"names" binding:"required"`
	}
	
	if err := c.ShouldBindJSON(&req); err != nil {
		applogger.Warn("API", "Invalid batch delete request", map[string]interface{}{
			"error": err.Error(),
		})
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request"})
		return
	}

	if len(req.Names) == 0 {
		applogger.Warn("API", "Empty repository list for batch delete", nil)
		c.JSON(http.StatusBadRequest, gin.H{"error": "No repositories specified"})
		return
	}

	applogger.Debug("API", "Executing batch delete", map[string]interface{}{
		"repository_count": len(req.Names),
		"repositories": req.Names,
	})
	
	// 执行删除操作
	result := db.Where("name IN ?", req.Names).Delete(&RepoStatus{})
	if result.Error != nil {
		logger.Error(result.Error, "Failed to execute batch delete", nil)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error"})
		return
	}

	logger.Success("Batch delete completed", map[string]interface{}{
		"deleted_count": result.RowsAffected,
		"requested_count": len(req.Names),
	})
	c.JSON(http.StatusOK, gin.H{
		"deleted_count": result.RowsAffected,
		"requested_count": len(req.Names),
	})
}

func batchRefreshHandler(c *gin.Context) {
	logger := applogger.NewRequestLogger("API")
	applogger.Debug("API", "Handling batch refresh request", nil)
	
	var req struct {
		Repositories []string `json:"repositories" binding:"required"`
	}
	
	if err := c.ShouldBindJSON(&req); err != nil {
		applogger.Warn("API", "Invalid batch refresh request", map[string]interface{}{
			"error": err.Error(),
		})
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request format"})
		return
	}

	if len(req.Repositories) == 0 {
		applogger.Warn("API", "Empty repository list for batch refresh", nil)
		c.JSON(http.StatusBadRequest, gin.H{"error": "No repositories specified"})
		return
	}

	applogger.Info("BATCH_REFRESH", "Starting batch refresh", map[string]interface{}{
		"repository_count": len(req.Repositories),
	})

	applogger.Debug("API", "Setting up batch refresh operation", map[string]interface{}{
		"repository_count": len(req.Repositories),
	})
	
	semaphore := make(chan struct{}, 3)
	var wg sync.WaitGroup
	
	type updateResult struct {
		name    string
		success bool
		error   string
	}
	
	results := make(chan updateResult, len(req.Repositories))

	for _, repoFullName := range req.Repositories {
		wg.Add(1)
		go func(name string) {
			defer wg.Done()
			
			semaphore <- struct{}{}
			defer func() { <-semaphore }()

			parts := strings.Split(name, "/")
			if len(parts) != 2 {
				applogger.Warn("API", "Invalid repository format in batch refresh", map[string]interface{}{
					"repository": name,
				})
				results <- updateResult{name: name, success: false, error: "Invalid repository format"}
				return
			}

			applogger.Debug("API", "Fetching repository status in batch refresh", map[string]interface{}{
				"repository": name,
				"owner": parts[0],
				"repo": parts[1],
			})
			status := getRepoStatus(parts[0], parts[1])

			updates := map[string]interface{}{
				"last_commit_sha": status.LastCommitSHA,
				"last_update":     status.LastUpdate,
				"commit_message":  status.CommitMessage,
				"committer":       status.Committer,
				"error":           status.Error,
				"updated_at":      time.Now(),
			}

			applogger.Debug("API", "Updating repository in database", map[string]interface{}{
				"repository": name,
				"last_commit": status.LastCommitSHA,
			})
			if err := db.Model(&RepoStatus{}).Where("name = ?", name).Updates(updates).Error; err != nil {
				logger.Error(err, "Failed to update repository in database", map[string]interface{}{
					"repository": name,
				})
				results <- updateResult{name: name, success: false, error: "Database update failed"}
			} else {
				if status.Error == "" {
					applogger.Debug("API", "Repository refresh successful", map[string]interface{}{
					"repository": name,
				})
					results <- updateResult{name: name, success: true}
				} else {
					applogger.Warn("API", "Repository refresh encountered error", map[string]interface{}{
						"repository": name,
						"error": status.Error,
					})
					results <- updateResult{name: name, success: false, error: status.Error}
				}
			}

			time.Sleep(200 * time.Millisecond)
		}(repoFullName)
	}

	go func() {
		wg.Wait()
		close(results)
	}()

	var successCount, failedCount int
	var failures []string

	for result := range results {
		if result.success {
			successCount++
		} else {
			failedCount++
			failures = append(failures, fmt.Sprintf("%s: %s", result.name, result.error))
		}
	}

	applogger.Info("BATCH_REFRESH", "Batch refresh completed", map[string]interface{}{
		"success_count": successCount,
		"failed_count": failedCount,
		"total_count": len(req.Repositories),
	})

	response := gin.H{
		"success": successCount,
		"failed":  failedCount,
		"total":   len(req.Repositories),
	}

	if len(failures) > 0 {
		response["failures"] = failures
	}

	c.JSON(http.StatusOK, response)
}

// 手动检测单个仓库状态
func manualCheckRepositoryHandler(c *gin.Context) {
	logger := applogger.NewRequestLogger("API")
	
	owner := c.Param("owner")
	repo := c.Param("repo")
	fullName := fmt.Sprintf("%s/%s", owner, repo)
	
	applogger.Debug("API", "Handling manual repository check request", map[string]interface{}{
		"repository": fullName,
		"owner": owner,
		"repo": repo,
	})

	// 检查仓库是否存在于数据库中
	var existingRepo RepoStatus
	if err := db.Where("name = ?", fullName).First(&existingRepo).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			applogger.Warn("API", "Repository not found for manual check", map[string]interface{}{
				"repository": fullName,
			})
			c.JSON(http.StatusNotFound, gin.H{"error": "Repository not found"})
			return
		} else {
			logger.Error(err, "Failed to check repository existence", map[string]interface{}{
				"repository": fullName,
			})
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error"})
			return
		}
	}

	applogger.Info("API", "Starting manual repository status check", map[string]interface{}{
		"repository": fullName,
		"id": existingRepo.ID,
	})

	// 获取最新状态
	status := getRepoStatus(owner, repo)
	
	// 更新数据库
	updates := map[string]interface{}{
		"last_commit_sha": status.LastCommitSHA,
		"last_update":     status.LastUpdate,
		"commit_message":  status.CommitMessage,
		"committer":       status.Committer,
		"error":           status.Error,
		"updated_at":      time.Now(),
	}

	if err := db.Model(&RepoStatus{}).Where("name = ?", fullName).Updates(updates).Error; err != nil {
		logger.Error(err, "Failed to update repository status", map[string]interface{}{
			"repository": fullName,
		})
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update repository status"})
		return
	}

	// 获取更新后的完整记录
	var updatedRepo RepoStatus
	if err := db.Where("name = ?", fullName).First(&updatedRepo).Error; err != nil {
		logger.Error(err, "Failed to fetch updated repository", map[string]interface{}{
			"repository": fullName,
		})
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error"})
		return
	}

	if status.Error != "" {
		applogger.Warn("API", "Manual repository check completed with error", map[string]interface{}{
			"repository": fullName,
			"error": status.Error,
		})
	} else {
		logger.Success("Manual repository check completed successfully", map[string]interface{}{
			"repository": fullName,
			"last_commit": status.LastCommitSHA,
		})
	}

	c.JSON(http.StatusOK, gin.H{
		"message": "Repository status updated successfully",
		"repository": updatedRepo,
		"has_error": status.Error != "",
	})
}

// 手动检测所有仓库状态
func manualCheckAllRepositoriesHandler(c *gin.Context) {
	logger := applogger.NewRequestLogger("API")
	applogger.Debug("API", "Handling manual check all repositories request", nil)

	// 获取所有仓库
	var repositories []RepoStatus
	if err := db.Find(&repositories).Error; err != nil {
		logger.Error(err, "Failed to fetch repositories for manual check", nil)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error"})
		return
	}

	if len(repositories) == 0 {
		applogger.Info("API", "No repositories found for manual check", nil)
		c.JSON(http.StatusOK, gin.H{
			"message": "No repositories to check",
			"total_count": 0,
			"updated_count": 0,
			"error_count": 0,
		})
		return
	}

	applogger.Info("API", "Starting manual check for all repositories", map[string]interface{}{
		"repository_count": len(repositories),
	})

	// 异步执行更新，避免长时间阻塞
	go func() {
		updateLogger := applogger.NewRequestLogger("MANUAL_UPDATE")
		
		var successCount, errorCount int
		var errorRepos []string

		batchSize := 3
		for i := 0; i < len(repositories); i += batchSize {
			end := i + batchSize
			if end > len(repositories) {
				end = len(repositories)
			}

			var wg sync.WaitGroup
			var mu sync.Mutex

			for j := i; j < end; j++ {
				wg.Add(1)
				go func(repo RepoStatus) {
					defer wg.Done()
					
					parts := strings.Split(repo.Name, "/")
					if len(parts) != 2 {
						mu.Lock()
						errorCount++
						errorRepos = append(errorRepos, fmt.Sprintf("%s: invalid format", repo.Name))
						mu.Unlock()
						return
					}
					
					status := getRepoStatus(parts[0], parts[1])
					
					updates := map[string]interface{}{
						"last_commit_sha": status.LastCommitSHA,
						"last_update":     status.LastUpdate,
						"commit_message":  status.CommitMessage,
						"committer":       status.Committer,
						"error":           status.Error,
						"updated_at":      time.Now(),
					}

					if err := db.Model(&RepoStatus{}).Where("name = ?", repo.Name).Updates(updates).Error; err != nil {
						updateLogger.Error(err, "Failed to update repository during manual check", map[string]interface{}{
							"repository": repo.Name,
						})
						mu.Lock()
						errorCount++
						errorRepos = append(errorRepos, fmt.Sprintf("%s: database update failed", repo.Name))
						mu.Unlock()
					} else {
						mu.Lock()
						if status.Error != "" {
							errorCount++
							errorRepos = append(errorRepos, fmt.Sprintf("%s: %s", repo.Name, status.Error))
						} else {
							successCount++
						}
						mu.Unlock()
					}
				}(repositories[j])
			}
			wg.Wait()
			
			// 批次间延迟
			if end < len(repositories) {
				time.Sleep(2 * time.Second)
			}
		}

		updateLogger.Success("Manual check for all repositories completed", map[string]interface{}{
			"total_count": len(repositories),
			"success_count": successCount,
			"error_count": errorCount,
		})
	}()

	c.JSON(http.StatusAccepted, gin.H{
		"message": "Manual check for all repositories started in background",
		"total_count": len(repositories),
		"status": "processing",
	})
}

// 保存配置到文件
func saveConfig() error {
	return fmt.Errorf("deprecated: configuration is stored in database")
}

// 获取配置处理函数
func getConfigHandler(c *gin.Context) {
	// 从数据库读取最新配置，返回安全视图
	var appCfg AppConfig
	if err := db.First(&appCfg, 1).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load configuration"})
		return
	}
	resp := struct {
		UpdateInterval        int  `json:"update_interval"`
		InitialDelay          int  `json:"initial_delay"`
		MaxConcurrentRequests int  `json:"max_concurrent_requests"`
		RequestDelay          int  `json:"request_delay"`
		HasToken              bool `json:"has_token"`
	}{
		UpdateInterval:        appCfg.UpdateInterval,
		InitialDelay:          appCfg.InitialDelay,
		MaxConcurrentRequests: appCfg.MaxConcurrentRequests,
		RequestDelay:          appCfg.RequestDelay,
		HasToken:              appCfg.GitHubToken != "",
	}
	c.JSON(http.StatusOK, resp)
}

// 更新配置处理函数
func updateConfigHandler(c *gin.Context) {
	logger := applogger.NewRequestLogger("API")
	
	// 解析请求体
	var updateRequest struct {
		GitHubToken          string `json:"github_token"`
		UpdateInterval       int    `json:"update_interval"`
		InitialDelay         int    `json:"initial_delay"`
		MaxConcurrentRequests int    `json:"max_concurrent_requests"`
		RequestDelay         int    `json:"request_delay"`
	}
	
	if err := c.ShouldBindJSON(&updateRequest); err != nil {
		logger.Error(err, "Failed to parse request body", nil)
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request format"})
		return
	}
	
	// 更新配置
	oldConfig := config
	
	// 只有当提供了新token时才更新
	if updateRequest.GitHubToken != "" {
		config.GitHubToken = updateRequest.GitHubToken
	}
	
	// 更新其他配置项
	if updateRequest.UpdateInterval > 0 {
		config.UpdateInterval = updateRequest.UpdateInterval
	}
	
	if updateRequest.InitialDelay >= 0 {
		config.InitialDelay = updateRequest.InitialDelay
	}
	
	if updateRequest.MaxConcurrentRequests > 0 {
		config.MaxConcurrentRequests = updateRequest.MaxConcurrentRequests
	}
	
	if updateRequest.RequestDelay > 0 {
		config.RequestDelay = updateRequest.RequestDelay
	}
	
	// 保存配置到数据库
	if err := saveConfigToDB(); err != nil {
		logger.Error(err, "Failed to save configuration to database", nil)
		// 恢复旧配置
		config = oldConfig
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save configuration to database"})
		return
	}
	
	// 如果GitHub Token改变，重新初始化客户端
	if oldConfig.GitHubToken != config.GitHubToken && config.GitHubToken != "" {
		initializeGitHubClient()
	}
	
	// 如果rate limiter配置改变，重新初始化
	if oldConfig.MaxConcurrentRequests != config.MaxConcurrentRequests || 
	   oldConfig.RequestDelay != config.RequestDelay {
		// 重新初始化rate limiter
		rateLimiter = make(chan struct{}, config.MaxConcurrentRequests)
		requestDelay = time.Duration(config.RequestDelay) * time.Millisecond
	}
	
	logger.Success("Configuration updated successfully", nil)
	c.JSON(http.StatusOK, gin.H{"message": "Configuration updated successfully"})
}

func webhookHandler(c *gin.Context) {
	logger := applogger.NewRequestLogger("API")
	applogger.Debug("API", "Handling webhook request", nil)
	
	var event github.PushEvent
	if err := c.ShouldBindJSON(&event); err != nil {
		applogger.Warn("API", "Invalid webhook payload", map[string]interface{}{
			"error": err.Error(),
		})
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid webhook payload"})
		return
	}

	if event.Repo == nil || event.Repo.FullName == nil {
		applogger.Warn("API", "Missing repository information in webhook", nil)
		c.JSON(http.StatusBadRequest, gin.H{"error": "Missing repository information"})
		return
	}

	repoName := *event.Repo.FullName
	applogger.Info("API", "Received webhook for repository", map[string]interface{}{
		"repository": repoName,
		"ref": event.GetRef(),
		"sender": event.GetSender().GetLogin(),
	})

	parts := strings.Split(repoName, "/")
	if len(parts) == 2 {
		applogger.Debug("API", "Fetching repository status from webhook", map[string]interface{}{
			"owner": parts[0],
			"repo": parts[1],
		})
		status := getRepoStatus(parts[0], parts[1])
		
		var existingStatus RepoStatus
		if err := db.First(&existingStatus, "name = ?", status.Name).Error; err != nil {
			applogger.Info("API", "Creating new repository from webhook", map[string]interface{}{
				"repository": status.Name,
			})
			db.Create(&status)
		} else {
			applogger.Info("API", "Updating existing repository from webhook", map[string]interface{}{
				"repository": status.Name,
				"last_commit": status.LastCommitSHA,
			})
			db.Model(&existingStatus).Updates(status)
		}
	}

	logger.Success("Webhook processed successfully", map[string]interface{}{
		"repository": repoName,
	})
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

// 检测GitHub API状态和token信息
func checkGitHubAPIStatus() GitHubAPIStatus {
	statusMutex.Lock()
	defer statusMutex.Unlock()
	
	status := GitHubAPIStatus{
		LastChecked: time.Now(),
		TokenValid:  false,
	}
	
	if config.GitHubToken == "" {
		status.Error = "GitHub token not configured"
		githubAPIStatus = status
		return status
	}
	
	if githubClient == nil {
		status.Error = "GitHub client not initialized"
		githubAPIStatus = status
		return status
	}
	
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	
	// 检查token有效性和获取用户信息
	user, resp, err := githubClient.Users.Get(ctx, "")
	if err != nil {
		status.Error = fmt.Sprintf("Failed to validate token: %v", err)
		githubAPIStatus = status
		return status
	}
	
	if resp.StatusCode != 200 {
		status.Error = fmt.Sprintf("Invalid token: HTTP %d", resp.StatusCode)
		githubAPIStatus = status
		return status
	}
	
	status.TokenValid = true
	if user.Login != nil {
		status.Username = *user.Login
	}
	
	// 获取速率限制信息
	if resp.Rate.Limit > 0 {
		status.RateLimit = RateLimit{
			Limit:     resp.Rate.Limit,
			Used:      resp.Rate.Limit - resp.Rate.Remaining,
			Remaining: resp.Rate.Remaining,
			ResetTime: resp.Rate.Reset.Time,
		}
	}
	
	// 检测token权限
	status.Permissions = checkTokenPermissions(ctx)
	
	// 检测token类型和过期时间
	status.TokenType = detectTokenType(config.GitHubToken)
	
	githubAPIStatus = status
	return status
}

// 检测token权限
func checkTokenPermissions(ctx context.Context) []string {
	permissions := []string{}
	
	// 测试仓库访问权限
	_, _, err := githubClient.Repositories.Get(ctx, "octocat", "Hello-World")
	if err == nil {
		permissions = append(permissions, "public_repo")
	}
	
	// 测试私有仓库权限（通过列出用户的仓库）
	opts := &github.RepositoryListOptions{
		Visibility: "private",
		ListOptions: github.ListOptions{PerPage: 1},
	}
	repos, resp, err := githubClient.Repositories.List(ctx, "", opts)
	if err == nil && resp.StatusCode == 200 && len(repos) >= 0 {
		permissions = append(permissions, "repo")
	}
	
	// 测试用户信息权限
	_, _, err = githubClient.Users.Get(ctx, "")
	if err == nil {
		permissions = append(permissions, "user")
	}
	
	return permissions
}

// 检测token类型
func detectTokenType(token string) string {
	if strings.HasPrefix(token, "ghp_") {
		return "classic"
	} else if strings.HasPrefix(token, "github_pat_") {
		return "fine-grained"
	}
	return "unknown"
}

// 获取GitHub API状态（线程安全）
func getGitHubAPIStatus() GitHubAPIStatus {
	statusMutex.RLock()
	defer statusMutex.RUnlock()
	return githubAPIStatus
}

// 获取GitHub API状态处理函数
func getGitHubStatusHandler(c *gin.Context) {
	applogger.Debug("API", "Handling GitHub status request", nil)
	
	// 获取当前状态
	status := getGitHubAPIStatus()
	
	// 如果状态超过5分钟，重新检查
	if time.Since(status.LastChecked) > 5*time.Minute {
		applogger.Debug("API", "GitHub status cache expired, refreshing...", nil)
		status = checkGitHubAPIStatus()
	}
	
	c.JSON(http.StatusOK, status)
}

// 刷新GitHub API状态处理函数
func refreshGitHubStatusHandler(c *gin.Context) {
	logger := applogger.NewRequestLogger("API")
	applogger.Debug("API", "Handling GitHub status refresh request", nil)
	
	status := checkGitHubAPIStatus()
	
	if status.TokenValid {
		logger.Success("GitHub API status refreshed successfully", map[string]interface{}{
			"username": status.Username,
			"rate_limit_remaining": status.RateLimit.Remaining,
		})
	} else {
		applogger.Warn("API", "GitHub API status refresh failed", map[string]interface{}{
			"error": status.Error,
		})
	}
	
	c.JSON(http.StatusOK, status)
}

func Run() {
	// 初始化日志系统
	logLevel := applogger.INFO
	if os.Getenv("LOG_LEVEL") == "DEBUG" {
		logLevel = applogger.DEBUG
	}
	applogger.Init(logLevel)
	
	applogger.Info("STARTUP", "Starting GitHub Repository Monitor v2.0", nil)
	
	// 先初始化数据库，再加载配置，再初始化 GitHub 客户端
	initializeDB()
	loadConfig()
	initializeGitHubClient()

	// 启动后台任务处理器
	startBackgroundProcessor()

	// 异步执行初始仓库状态检查，不阻塞服务器启动
	go func() {
		applogger.Info("STARTUP", "Performing initial repository status check in background", nil)
		updateAllStatuses()
		initialCheckComplete = true
		applogger.Info("STARTUP", "Initial repository status check complete", nil)
	}()

	// 定时任务：根据配置的更新频率更新
	go func() {
		// 默认10分钟，如果配置了则使用配置值
		updateInterval := 10
		if config.UpdateInterval > 0 {
			updateInterval = config.UpdateInterval
		}
		applogger.Info("SCHEDULER", fmt.Sprintf("Setting update interval to %d minutes", updateInterval), nil)
		
		ticker := time.NewTicker(time.Duration(updateInterval) * time.Minute)
		defer ticker.Stop()
		
		for range ticker.C {
			applogger.Debug("SCHEDULER", "Starting scheduled repository update", nil)
			updateAllStatuses()
		}
	}()

	// 定时任务：检查GitHub API状态（每30分钟）
	go func() {
		applogger.Info("SCHEDULER", "Setting GitHub API status check interval to 30 minutes", nil)
		
		ticker := time.NewTicker(30 * time.Minute)
		defer ticker.Stop()
		
		for range ticker.C {
			applogger.Debug("SCHEDULER", "Starting scheduled GitHub API status check", nil)
			status := checkGitHubAPIStatus()
			
			if !status.TokenValid {
				applogger.Error("SCHEDULER", fmt.Errorf(status.Error), "GitHub API status check failed")
			} else {
				// 检查速率限制使用情况
				usagePercent := float64(status.RateLimit.Used) / float64(status.RateLimit.Limit) * 100
				if usagePercent > 80 {
					applogger.Warn("SCHEDULER", "GitHub API rate limit usage is high", map[string]interface{}{
						"used": status.RateLimit.Used,
						"limit": status.RateLimit.Limit,
						"usage_percent": usagePercent,
						"reset_time": status.RateLimit.ResetTime,
					})
				} else {
					applogger.Debug("SCHEDULER", "GitHub API status check successful", map[string]interface{}{
						"rate_limit_remaining": status.RateLimit.Remaining,
						"usage_percent": usagePercent,
					})
				}
			}
		}
	}()

	if os.Getenv("GIN_MODE") == "" {
		gin.SetMode(gin.ReleaseMode)
	}

	r := gin.Default()
	
	// 请求日志中间件
	r.Use(func(c *gin.Context) {
		start := time.Now()
		path := c.Request.URL.Path
		method := c.Request.Method
		
		c.Next()
		
		duration := time.Since(start)
		statusCode := c.Writer.Status()
		
		// 只记录API请求，不记录静态文件请求
		if strings.HasPrefix(path, "/api/") {
			logData := map[string]interface{}{
				"method": method,
				"path": path,
				"status": statusCode,
				"duration": duration.String(),
				"ip": c.ClientIP(),
			}
			
			message := fmt.Sprintf("HTTP %d %s %s", statusCode, method, path)
			
			if statusCode >= 500 {
				applogger.ErrorWithData("HTTP", fmt.Errorf("HTTP %d", statusCode), message, logData)
			} else if statusCode >= 400 {
				applogger.Warn("HTTP", message, logData)
			} else {
				applogger.Info("HTTP", message, logData)
			}
		}
	})
	
	r.Use(func(c *gin.Context) {
		c.Header("Access-Control-Allow-Origin", "*")
		c.Header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Content-Type")
		
		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		
		c.Next()
	})
	
	api := r.Group("/api")
	{
		api.GET("/status", statusHandler)
		api.GET("/init-status", func(c *gin.Context) {
			applogger.Debug("API", "Handling init-status request", map[string]interface{}{
				"initial_check_complete": initialCheckComplete,
			})
			c.JSON(http.StatusOK, gin.H{
				"initial_check_complete": initialCheckComplete,
			})
		})
		api.POST("/repositories", addRepositoryHandler)
		api.POST("/repositories/quick-add", quickAddRepositoryHandler)
		api.POST("/repositories/batch-quick-add", batchQuickAddRepositoryHandler)
		api.GET("/repositories/queue-status", getQueueStatusHandler)
		api.GET("/repositories/pending", getPendingRepositoriesHandler)
		api.DELETE("/repositories/:owner/:repo", deleteRepositoryHandler)
		api.DELETE("/repositories/batch", batchDeleteHandler)
		api.POST("/repositories/refresh", batchRefreshHandler)
		api.POST("/repositories/check-all", manualCheckAllRepositoriesHandler)
		api.POST("/repositories/:owner/:repo/check", manualCheckRepositoryHandler)
		api.POST("/webhook", webhookHandler)
		
		// 配置相关API
		api.GET("/config", getConfigHandler)
		api.POST("/config", updateConfigHandler)
		
		// GitHub API状态相关API
		api.GET("/github/status", getGitHubStatusHandler)
		api.POST("/github/status/refresh", refreshGitHubStatusHandler)
		
		// 调试端点（仅开发时使用）
		api.GET("/debug/repositories", debugAllRepositoriesHandler)
		
		api.GET("/health", func(c *gin.Context) {
			githubStatus := getGitHubAPIStatus()
			
			// 获取数据库状态
			var repoCount int64
			db.Model(&RepoStatus{}).Count(&repoCount)
			
			// 获取队列状态
			var pendingCount, activeCount, errorCount int64
			db.Model(&RepoStatus{}).Where("status = ?", "pending").Count(&pendingCount)
			db.Model(&RepoStatus{}).Where("status = ?", "active").Count(&activeCount)
			db.Model(&RepoStatus{}).Where("status = ?", "error").Count(&errorCount)
			
			healthData := map[string]interface{}{
				"status": "healthy",
				"timestamp": time.Now(),
				"version": "2.0.0",
				"initial_check_complete": initialCheckComplete,
				"database": map[string]interface{}{
					"connected": true,
					"total_repositories": repoCount,
					"pending_repositories": pendingCount,
					"active_repositories": activeCount,
					"error_repositories": errorCount,
				},
				"github_api": map[string]interface{}{
					"status": githubStatus.TokenValid,
					"username": githubStatus.Username,
					"token_type": githubStatus.TokenType,
					"rate_limit": githubStatus.RateLimit,
					"last_checked": githubStatus.LastChecked,
					"error": githubStatus.Error,
				},
				"background_queue": map[string]interface{}{
					"queue_length": len(taskQueue),
					"workers_active": config.MaxConcurrentRequests,
				},
			}
			
			applogger.Debug("API", "Health check requested", map[string]interface{}{
				"github_token_valid": githubStatus.TokenValid,
				"repo_count": repoCount,
				"queue_length": len(taskQueue),
			})
			
			c.JSON(http.StatusOK, healthData)
		})
	}
	
	r.StaticFS("/web", http.Dir("web"))
	r.GET("/", func(c *gin.Context) {
		applogger.Debug("WEB", "Root path accessed, redirecting to web interface", map[string]interface{}{
			"client_ip": c.ClientIP(),
		})
		c.Redirect(http.StatusMovedPermanently, "/web/")
	})

	applogger.Info("SERVER", "Starting server", map[string]interface{}{
		"port": 8080,
		"version": "2.0.0",
	})
	
	// 设置优雅关闭
	srv := &http.Server{
		Addr:    ":8080",
		Handler: r,
	}
	
	// 启动服务器
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			applogger.Fatal("SERVER", err, "Failed to start server")
		}
	}()
	
	// 等待中断信号以优雅关闭服务器
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	
	applogger.Info("SERVER", "Shutting down server...", nil)
	
	// 5秒超时关闭服务器
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	
	if err := srv.Shutdown(ctx); err != nil {
		applogger.Fatal("SERVER", err, "Server forced to shutdown")
	}
	
	// 关闭日志文件
	applogger.Info("SERVER", "Server exited", nil)
	applogger.Close()
}
