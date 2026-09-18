var LAppDefine = {

    // 这里配置 canvas 元素的 id（与页面里的 <canvas id="live2d"> 对应）
    CANVAS_ID: "live2d",

    // 不允许拖拽：看板娘固定在右下角，不该被拖走
    IS_DRAGABLE: false,

    // 本页不提供换人/换装按钮，留空即可（框架不读，只有页面脚本用）
    BUTTON_ID: "",

    TEXURE_BUTTON_ID: "",
    /**
     *  模型定义
     *  原项目这里是 90 多个模型；本站只用其中一个，所以只留一项。
     *  路径相对于页面根目录。
     */
    MODELS: [
        ["live2d/22/22.model.json"]
    ]
};
