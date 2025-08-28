package logger

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"time"
)

// LogLevel 日志级别
type LogLevel int

const (
	DEBUG LogLevel = iota
	INFO
	WARN
	ERROR
	FATAL
)

// String 返回日志级别的字符串表示
func (l LogLevel) String() string {
	switch l {
	case DEBUG:
		return "DEBUG"
	case INFO:
		return "INFO"
	case WARN:
		return "WARN"
	case ERROR:
		return "ERROR"
	case FATAL:
		return "FATAL"
	default:
		return "UNKNOWN"
	}
}

// Logger 结构化日志记录器
type Logger struct {
	level    LogLevel
	logFile  *os.File
	failureFile *os.File  // 专门记录仓库添加失败的日志文件
	writers  []io.Writer
}

// LogEntry 日志条目
type LogEntry struct {
	Timestamp string      `json:"timestamp"`
	Level     string      `json:"level"`
	Operation string      `json:"operation"`
	Message   string      `json:"message"`
	Data      interface{} `json:"data,omitempty"`
	Error     string      `json:"error,omitempty"`
}

var defaultLogger = &Logger{
	level:   INFO,
	writers: []io.Writer{os.Stdout}, // 默认输出到控制台
}

// Init 初始化日志系统
func Init(level LogLevel) {
	defaultLogger.level = level
	log.SetFlags(0) // 使用自定义格式
	
	// 创建logs目录
	if err := os.MkdirAll("logs", 0755); err != nil {
		fmt.Printf("Failed to create logs directory: %v\n", err)
		return
	}
	
	// 创建主日志文件（按日期命名）
	logFileName := fmt.Sprintf("logs/app_%s.log", time.Now().Format("2006-01-02"))
	logFile, err := os.OpenFile(logFileName, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		fmt.Printf("Failed to open log file: %v\n", err)
		return
	}
	
	// 创建仓库添加失败日志文件
	failureFileName := fmt.Sprintf("logs/repo_add_failures_%s.log", time.Now().Format("2006-01-02"))
	failureFile, err := os.OpenFile(failureFileName, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		fmt.Printf("Failed to open failure log file: %v\n", err)
		// 如果失败日志文件创建失败，继续使用主日志文件
	} else {
		defaultLogger.failureFile = failureFile
	}
	
	defaultLogger.logFile = logFile
	defaultLogger.writers = []io.Writer{os.Stdout, logFile} // 同时输出到控制台和文件
}

// SetLevel 设置日志级别
func SetLevel(level LogLevel) {
	defaultLogger.level = level
}

// Close 关闭日志文件
func Close() {
	if defaultLogger.logFile != nil {
		defaultLogger.logFile.Close()
	}
	if defaultLogger.failureFile != nil {
		defaultLogger.failureFile.Close()
	}
}

// log 记录日志
func (l *Logger) log(level LogLevel, operation, message string, data interface{}, err error) {
	if level < l.level {
		return
	}

	entry := LogEntry{
		Timestamp: time.Now().Format("2006-01-02 15:04:05.000"),
		Level:     level.String(),
		Operation: operation,
		Message:   message,
		Data:      data,
	}

	if err != nil {
		entry.Error = err.Error()
	}

	// 开发环境使用人类可读格式
	var output string
	if os.Getenv("LOG_FORMAT") == "json" {
		jsonData, _ := json.Marshal(entry)
		output = string(jsonData)
	} else {
		// 人类可读格式
		logLine := fmt.Sprintf("[%s] [%s] %s: %s",
			entry.Timestamp,
			entry.Level,
			entry.Operation,
			entry.Message,
		)

		if entry.Data != nil {
			if dataStr, err := json.Marshal(entry.Data); err == nil {
				logLine += fmt.Sprintf(" | Data: %s", string(dataStr))
			}
		}

		if entry.Error != "" {
			logLine += fmt.Sprintf(" | Error: %s", entry.Error)
		}

		output = logLine
	}

	// 输出到所有配置的writer
	for _, writer := range l.writers {
		fmt.Fprintln(writer, output)
	}
}

// Debug 记录调试日志
func Debug(operation, message string, data interface{}) {
	defaultLogger.log(DEBUG, operation, message, data, nil)
}

// Info 记录信息日志
func Info(operation, message string, data interface{}) {
	defaultLogger.log(INFO, operation, message, data, nil)
}

// Warn 记录警告日志
func Warn(operation, message string, data interface{}) {
	defaultLogger.log(WARN, operation, message, data, nil)
}

// Error 记录错误日志
func Error(operation string, err error, message string) {
	defaultLogger.log(ERROR, operation, message, nil, err)
}

// Fatal 记录致命错误日志并退出程序
func Fatal(operation string, err error, message string) {
	defaultLogger.log(FATAL, operation, message, nil, err)
	os.Exit(1)
}

// WithData 记录带数据的错误日志
func ErrorWithData(operation string, err error, message string, data interface{}) {
	entry := LogEntry{
		Timestamp: time.Now().Format("2006-01-02 15:04:05.000"),
		Level:     ERROR.String(),
		Operation: operation,
		Message:   message,
		Data:      data,
		Error:     err.Error(),
	}

	var output string
	if os.Getenv("LOG_FORMAT") == "json" {
		jsonData, _ := json.Marshal(entry)
		output = string(jsonData)
	} else {
		logLine := fmt.Sprintf("[%s] [%s] %s: %s | Error: %s",
			entry.Timestamp,
			entry.Level,
			entry.Operation,
			entry.Message,
			entry.Error,
		)

		if entry.Data != nil {
			if dataStr, err := json.Marshal(entry.Data); err == nil {
				logLine += fmt.Sprintf(" | Data: %s", string(dataStr))
			}
		}

		output = logLine
	}

	// 输出到所有配置的writer
	for _, writer := range defaultLogger.writers {
		fmt.Fprintln(writer, output)
	}
}

// RequestLogger 请求日志记录器
type RequestLogger struct {
	StartTime time.Time
	Operation string
}

// NewRequestLogger 创建新的请求日志记录器
func NewRequestLogger(operation string) *RequestLogger {
	return &RequestLogger{
		StartTime: time.Now(),
		Operation: operation,
	}
}

// Success 记录成功的请求
func (r *RequestLogger) Success(message string, data interface{}) {
	duration := time.Since(r.StartTime)
	logData := map[string]interface{}{
		"duration": duration.String(),
	}
	
	if data != nil {
		logData["response"] = data
	}
	
	Info(r.Operation, message, logData)
}

// Error 记录失败的请求
func (r *RequestLogger) Error(err error, message string, data interface{}) {
	duration := time.Since(r.StartTime)
	logData := map[string]interface{}{
		"duration": duration.String(),
	}
	
	if data != nil {
		logData["context"] = data
	}
	
	ErrorWithData(r.Operation, err, message, logData)
}

// LogRepositoryFailure 专门记录仓库添加失败的日志
func LogRepositoryFailure(repository, reason string, err error, data interface{}) {
	entry := LogEntry{
		Timestamp: time.Now().Format("2006-01-02 15:04:05.000"),
		Level:     ERROR.String(),
		Operation: "REPO_ADD_FAILURE",
		Message:   fmt.Sprintf("Failed to add repository: %s | Reason: %s", repository, reason),
		Data:      data,
	}
	
	if err != nil {
		entry.Error = err.Error()
	}

	var output string
	if os.Getenv("LOG_FORMAT") == "json" {
		jsonData, _ := json.Marshal(entry)
		output = string(jsonData)
	} else {
		logLine := fmt.Sprintf("[%s] [%s] %s: %s",
			entry.Timestamp,
			entry.Level,
			entry.Operation,
			entry.Message,
		)

		if entry.Error != "" {
			logLine += fmt.Sprintf(" | Error: %s", entry.Error)
		}

		if entry.Data != nil {
			if dataStr, err := json.Marshal(entry.Data); err == nil {
				logLine += fmt.Sprintf(" | Data: %s", string(dataStr))
			}
		}

		output = logLine
	}

	// 输出到失败日志文件和控制台
	writers := []io.Writer{os.Stdout}
	if defaultLogger.failureFile != nil {
		writers = append(writers, defaultLogger.failureFile)
	}
	// 同时也写入主日志文件
	if defaultLogger.logFile != nil {
		writers = append(writers, defaultLogger.logFile)
	}
	
	for _, writer := range writers {
		fmt.Fprintln(writer, output)
	}
}
