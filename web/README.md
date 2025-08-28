# GitHub 仓库监控器 - 前端使用说明

## 📁 文件结构说明

### 主要入口文件
- **`index.html`** - 主要入口，增强版完整功能
- **`index-test.html`** - 简化版，用于测试和调试
- **`index-original.html`** - 原始版本备份

### 源代码目录 (`src/`)
- **`enhanced-main.js`** - 增强版应用入口
- **`main.js`** - 标准版应用入口  
- **`EnhancedApp.js`** - 增强版主组件（推荐使用）
- **`App.js`** - 标准版主组件

### 组件库 (`src/components/`)
```
components/
├── common/           # 通用组件
├── repository/       # 仓库管理组件
├── import/          # 导入功能组件
├── status/          # 状态面板组件
└── config/          # 配置管理组件
```

### 业务逻辑 (`src/composables/`)
- Vue3 组合式函数，包含业务逻辑复用

### 工具函数 (`src/utils/`)
- API 封装、格式化、本地存储等工具函数

### 样式文件 (`src/styles/`)
- CSS 变量和基础样式

## 🚀 快速开始

1. 启动 Go 后端服务器
```bash
go run main.go
```

2. 访问前端界面
- 主要版本：http://localhost:8080
- 测试版本：http://localhost:8080/index-test.html

## 🎯 功能特性

### 增强版功能 (`index.html`)
- ✅ 完整的仓库管理功能
- ✅ 高级批量导入（支持暂停/继续/取消）
- ✅ 实时状态监控和GitHub API状态
- ✅ 批量操作和高级筛选
- ✅ 导入状态持久化
- ✅ 成功操作提示

### 简化版功能 (`index-test.html`)
- ✅ 基础仓库列表显示
- ✅ 简单的增删改操作
- ✅ 适合快速测试和调试

## 🔧 开发说明

### 修改组件
1. 编辑 `src/components/` 下的对应组件文件
2. 刷新浏览器即可看到更改

### 添加新功能
1. 在 `src/components/` 中创建新组件
2. 在 `src/composables/` 中添加业务逻辑
3. 在主组件中引入和使用

### 样式修改
1. 修改 `src/styles/variables.css` 改变主题变量
2. 修改 `src/styles/base.css` 改变基础样式

## 📱 浏览器支持

- ✅ Chrome 88+
- ✅ Firefox 78+  
- ✅ Safari 14+
- ✅ Edge 88+
- ❌ IE 不支持

## 🐛 问题排查

1. **页面空白**: 检查浏览器控制台错误信息
2. **模块加载失败**: 确保服务器支持 ES6 模块
3. **API 请求失败**: 确保后端服务器正常运行
4. **样式异常**: 检查 CSS 文件是否正确加载

---

更新时间：2025年8月22日
