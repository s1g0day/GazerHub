
# GazerHub

实时监控与可视化 GitHub 仓库更新的轻量级面板，支持批量管理与高性能数据处理。

## 🚀 核心特性

- 🔍 **智能监控**: 实时获取GitHub仓库信息，支持大数据量处理
- 📊 **数据可视化**: 直观展示仓库状态、最后提交信息等关键指标
- 🎯 **批量操作**: 统一的添加/导入界面，支持单个和批量仓库管理
- 🔄 **自动刷新**: 可配置的定时更新机制
- 📱 **响应式设计**: 完美适配桌面、平板和移动设备
- 💾 **数据持久化**: SQLite本地数据库，数据安全可靠
- 🎨 **现代化UI**: 简洁美观的界面设计，卡片式布局
- ⚡ **高性能优化**: 分页渲染、防抖搜索、虚拟滚动

## 🛠️ 技术架构

### 后端技术栈
- **Go 1.25+**: 高性能后端服务
- **Gin Framework**: 轻量级Web框架
- **GORM**: 现代化ORM框架
- **SQLite**: 嵌入式数据库
- **GitHub API v63**: 官方GitHub API客户端
- **OAuth2**: GitHub认证支持

### 前端技术栈
- **Vue.js 3**: 渐进式JavaScript框架
- **原生CSS3**: Grid布局、Flexbox、响应式设计
- **HTML5**: 语义化标记，无障碍访问
- **零构建工具**: 直接部署，无需编译

## 📁 项目结构

```
GazerHub/
├── main.go                 # 应用程序入口
├── go.mod                  # Go模块依赖
├── go.sum                  # 依赖校验文件
├── gorm.db                 # SQLite数据库
├── internal/               # 核心业务逻辑
│   ├── api/handlers.go     # API路由处理（1900+行完整实现）
│   └── logger/logger.go    # 日志配置
├── logs/                   # 系统日志
│   ├── app_*.log          # 应用运行日志
│   └── repo_add_failures_*.log # 仓库添加失败日志
├── web/                    # 前端资源
│   ├── index.html          # 主应用页面
│   ├── test.html           # 系统测试页面
│   ├── README.md           # 前端说明文档
│   └── src/
│       ├── app.js          # 应用启动入口
│       ├── main.js         # 主应用组件
│       └── styles/main.css # 全局样式文件
└── 记录文档/                # 项目文档
    ├── 开发记录.md          # 开发过程记录
    ├── 更新记录.md          # 版本更新历史
    ├── 设计方案.md          # 系统设计方案
    └── 项目最终完成报告.md   # 项目完成总结
```

## 🚀 快速开始

### 环境要求
- Go 1.25 或更高版本
- 现代浏览器（Chrome 80+、Firefox 75+、Safari 13+）

### 安装与运行

1. **获取项目**
```bash
git clone <repository-url>
cd GazerHub
```

2. **安装依赖**
```bash
go mod download
```

3. **配置系统（数据库持久化）**

- 方式一：前端界面 → 点击右上角"系统配置"保存参数；
- 方式二：调用 API：
  - 获取配置：`GET /api/config`
  - 更新配置：`POST /api/config`
    - Body（仅列出支持字段；未填写的字段不修改；`github_token` 仅在提供时更新）：
    ```json
    {
      "github_token": "ghp_xxx",
      "update_interval": 10,
      "initial_delay": 0,
      "max_concurrent_requests": 3,
      "request_delay": 1000
    }
    ```

4. **启动服务**
```bash
go run main.go
```

5. **访问应用**
- 主应用: http://localhost:8080
- 系统测试: http://localhost:8080/test.html
- 系统状态: 点击右上角"系统状态"按钮

## 📖 使用指南

### 仓库管理
- **添加仓库**: 输入`owner/repo`格式，支持GitHub链接自动解析
- **批量导入**: 多行输入，每行一个仓库
- **智能搜索**: 实时搜索仓库名称和描述
- **灵活排序**: 点击表头按任意字段排序
- **批量删除**: 选择多个仓库进行批量操作

### 性能优化
- **分页控制**: 10/25/50条/页或自定义
- **防抖搜索**: 减少不必要的API调用
- **增量更新**: 只更新变化的数据
- **状态缓存**: 智能缓存机制

### 响应式特性
- **桌面优先**: 大屏幕完整功能体验
- **移动友好**: 小屏幕优化布局
- **触摸支持**: 手势操作支持

## 🔌 API接口

| 端点 | 方法 | 功能描述 |
|------|------|----------|
| `/api/repositories` | GET | 获取仓库列表（支持分页和搜索） |
| `/api/repositories` | POST | 添加单个仓库 |
| `/api/repositories/batch` | POST | 批量添加仓库 |
| `/api/repositories/:id` | DELETE | 删除指定仓库 |
| `/api/repositories/batch` | DELETE | 批量删除仓库 |
| `/api/repositories/refresh` | POST | 刷新仓库信息 |
| `/api/system/status` | GET | 获取系统运行状态 |
| `/api/config` | GET | 获取当前系统配置（安全视图，不含 token） |
| `/api/config` | POST | 更新系统配置（写入数据库，部分字段可选） |

## ⚙️ 配置选项（存储于 SQLite，单行记录）

- `github_token`：GitHub API 令牌（提高速率限制）；仅在传入时更新
- `update_interval`：定时更新间隔，单位：分钟（默认 10）
- `initial_delay`：启动后首次更新延迟，单位：秒（默认 0）
- `max_concurrent_requests`：最大并发 GitHub 请求数（默认 3）
- `request_delay`：请求间延迟，单位：毫秒（默认 1000）

说明：
- 配置持久化在数据库表中（单例记录，主键 ID=1）。
- 日志相关通过环境变量控制：
  - `LOG_LEVEL=DEBUG` 可开启调试日志（默认 INFO）
  - `LOG_FORMAT=json` 可切换 JSON 输出（默认人类可读）

## 🎯 性能特性

- **分页渲染**: 大数据集下的流畅体验
- **虚拟滚动**: 支持数万条记录无卡顿
- **防抖搜索**: 300ms延迟，减少服务器压力
- **增量刷新**: 智能检测变化，精准更新
- **资源预加载**: 关键资源提前加载
- **后台任务处理**: 异步处理仓库状态更新
- **速率限制管理**: 智能GitHub API请求控制

## 📱 响应式设计

### 断点设计
- **大屏 (≥1200px)**: 完整功能布局
- **中屏 (768px-1199px)**: 紧凑布局
- **小屏 (<768px)**: 移动优化布局

### 适配特性
- 自适应网格布局
- 灵活的表格显示
- 触摸友好的交互元素
- 小屏幕下的UI重排

## 🏗️ 开发指南

### 后端开发
```bash
# 热重载开发
go run main.go

# 构建生产版本
go build -o gazerhub main.go

# 调试模式
LOG_LEVEL=DEBUG go run main.go
```

### 前端开发
- 无构建工具，直接修改源文件
- 使用Vue.js 3 Composition API
- 遵循组件化架构思想
- 现代化CSS特性

### 代码规范
- Go: 遵循官方Go代码规范
- JavaScript: ES6+语法，Vue.js最佳实践
- CSS: BEM命名规范，移动优先设计

## 📈 系统监控

系统提供实时性能监控：
- CPU和内存使用情况
- 数据库连接状态
- API响应时间统计
- GitHub API速率限制监控
- 错误率监控
- 后台任务执行状态

## 🔧 系统特性

### 后台任务系统
- 异步仓库状态更新
- 定时任务调度
- 任务队列管理
- 错误重试机制

### 日志系统
- 结构化日志输出
- 多级别日志控制
- 文件轮转
- 错误追踪

### 数据库管理
- SQLite嵌入式数据库
- GORM自动迁移
- 数据备份恢复
- 性能优化

## 🤝 贡献指南

1. Fork项目仓库
2. 创建功能分支: `git checkout -b feature/新功能`
3. 提交改动: `git commit -m '添加新功能'`
4. 推送分支: `git push origin feature/新功能`
5. 提交Pull Request

### 开发规范
- 提交前运行测试
- 遵循代码规范
- 更新相关文档
- 保持向后兼容

## 📋 更新日志

查看 [更新记录.md](记录文档/更新记录.md) 了解详细版本历史。

## 📄 许可证

本项目采用 MIT 许可证 - 详见 [LICENSE](LICENSE) 文件。

## 📞 支持与反馈

- 🐛 **Bug报告**: 提交GitHub Issue
- 💡 **功能建议**: 创建Feature Request
- 📖 **文档问题**: 查看项目文档目录
- 🤝 **参与贡献**: 欢迎提交Pull Request

---

*由GitHub Copilot强力驱动 🚀*
