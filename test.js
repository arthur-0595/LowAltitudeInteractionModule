// 简单测试cesium-engine能否被正确导入和实例化
import LowAltitudeInteraction from './src/index.js';

const sdk = new LowAltitudeInteraction();
if (sdk && typeof sdk.init === 'function') {
  console.log('cesium-engine 导入和实例化成功');
} else {
  console.error('cesium-engine 导入或实例化失败');
  process.exit(1);
} 