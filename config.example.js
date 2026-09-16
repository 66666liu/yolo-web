/**
 * 夜鹭页录 · 站点配置文件（模板）
 *
 * 用法：把本文件复制成 config.js 再改（config.js 已在 .gitignore 里，不会进仓库，
 * 适合放 ADMIN_KEY_HASH 这类口令）。没有 config.js 时服务会直接读取本模板，
 * 也就是说缺省值开箱即用。
 *
 * 优先级：环境变量 > config.js > 本文件里的默认值。
 *          环境变量只有这几个：PORT / TRUST_PROXY / UPLOAD_DAILY_LIMIT /
 *          ADMIN_KEY / ADMIN_KEY_HASH / ADMIN_SESSION_HOURS
 *          （其余参数请直接改本文件；启动日志会打印每个参数的实际取值与来源）
 *
 * 改完重启服务生效：node server.js
 */
module.exports = {
    // ---------- 基础 ----------
    port: 3000,                     // 监听端口（环境变量 PORT 可覆盖）
    trustProxy: 'loopback',         // Express trust proxy。本机 natapp 用 'loopback'；
                                    // 代理不在本机时填 true / 跳数 / 'IP或CIDR列表'
    corsOrigins: [                  // 允许跨域访问的站点（同源访问不需要，可以留空数组）
        'http://localhost:3000',
        'http://b6a58fd3.natappfree.cc'
    ],

    // ---------- 上传 ----------
    maxImageMB: 20,                 // 单张图片大小上限（MB），前后端共用这个值
    uploadDailyLimit: 8,            // 每个 IP 每天能成功上传几次；0 = 不限量（本地测试用）
    operationLogKeepDays: 30,       // 操作日志保留天数
    quotaKeepDays: 7,               // 上传额度记录保留天数（删掉 ip_operations.json 也能立即重置）

    // ---------- 上传 / 检测 / 删除 的防刷限流（每分钟每 IP）----------
    writeBurstPerMinute: 30,        // 写操作（上传/编辑/删除/打包）
    detectPerMinute: 20,            // 夜鹭检测（只读，可放宽）

    // ---------- 图片查重（上传时检测图鉴内是否已有同图）----------
    // 算法与 scripts/find_similar_images.py 一致（感知哈希 + 灰度向量），
    // 命中就拒绝上传（前端拦下 + 服务端 409），文件 sha256 相同必定算命中。
    // 指纹缓存在 dedup_cache.json（已在 .gitignore 里），删掉会重新计算。
    dedup: {
        enabled: true,              // false = 关闭查重（接口与前端红字提示一并停用）
        threshold: 0.90             // 相似度阈值 0.70–0.99，越高越严（0.90 = 脚本默认值）
    },

    // ---------- 管理员（编辑与删除图片） ----------
    // 进入后台：页面搜索框输入 `login 你的口令` 回车；退出：输入 `exit` 回车。
    // 公网部署请只填 adminKeyHash（口令的 SHA-256），不要填明文 adminKey。
    // 生成哈希：node -e "console.log(require('crypto').createHash('sha256').update('你的口令').digest('hex'))"
    adminKeyHash: '',               // 64 位十六进制；留空表示用明文 adminKey
    adminKey: '',                   // 明文口令（仅本地方便；留空 + 哈希留空 = 默认 yelu666）
    adminSessionHours: 12,          // 登录后会话有效小时数
    adminLoginAttempts: 8,          // 登录接口：窗口内最多尝试次数
    adminLoginWindowMinutes: 5,     // 登录接口：限流窗口（分钟）

    // ---------- 抽卡 ----------
    gacha: {
        dailySingleTickets: 2,      // 每日首次访问赠送的单抽券
        dailyTenTickets: 1,         // 每日首次访问赠送的十连券
        tenPullSingleCost: 10,      // 没有十连券时，一次十连消耗多少张单抽券
        zipMaxImages: 10,           // 一次最多打包下载几张（一个十连的量）

        // 稀有度档位：按点赞数排名从上到下切档
        //   rate  = 抽到该档位的概率（总和会被自动归一到 1）
        //   share = 该档位占奖池的比例（点赞最高的 share 部分进第一档，总和归一到 1）
        // 默认：传说=点赞最高 2%（概率 5%）、史诗=接下来 8%（15%）、稀有=30%（30%）、普通=60%（50%）
        // 想加档位：在这里加一项即可（前端颜色会按档位顺序自动分配；
        //           想在页面里用固定配色，就去 public/index.html 的 TIER_STYLE 里补上 key）
        tiers: [
            { key: 'legendary', label: '传说', rate: 0.05, share: 0.02 },
            { key: 'epic', label: '史诗', rate: 0.15, share: 0.08 },
            { key: 'rare', label: '稀有', rate: 0.30, share: 0.30 },
            { key: 'common', label: '普通', rate: 0.50, share: 0.60 }
        ]
    }
};
