// 主应用入口文件
import MainApp from './main.js';

console.log('正在初始化GitHub仓库监控器...');

// 创建Vue应用实例
const { createApp } = Vue;

// 全局错误处理
window.addEventListener('error', (event) => {
  console.error('全局错误:', event.error);
});

try {
  console.log('创建Vue应用实例...');
  const app = createApp(MainApp);
  
  // 全局错误处理器
  app.config.errorHandler = (error, vm, info) => {
    console.error('Vue应用错误:', error);
    console.error('错误信息:', info);
  };
  
  console.log('挂载应用到 #app...');
  app.mount('#app');
  
  console.log('✅ 应用启动成功！');
} catch (error) {
  console.error('❌ 应用启动失败:', error);
  
  // 显示错误信息给用户
  const appDiv = document.getElementById('app');
  if (appDiv) {
    appDiv.innerHTML = `
      <div style="text-align: center; padding: 2em; color: #dc3545;">
        <h2>应用启动失败</h2>
        <p>错误信息: ${error.message}</p>
        <p style="font-size: 14px; color: #6c757d;">请检查浏览器控制台获取详细错误信息</p>
        <button onclick="location.reload()" style="padding: 10px 20px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer;">
          重新加载
        </button>
      </div>
    `;
  }
}
