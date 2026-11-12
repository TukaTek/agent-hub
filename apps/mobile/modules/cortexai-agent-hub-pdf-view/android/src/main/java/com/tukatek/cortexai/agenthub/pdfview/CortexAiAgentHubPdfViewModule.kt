package com.tukatek.cortexai.agenthub.pdfview

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** A PDF drawn with the system PdfRenderer; Android's WebView cannot show one. */
class CortexAiAgentHubPdfViewModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CortexAiAgentHubPdfView")

    View(CortexAiAgentHubPdfView::class) {
      Events("onLoadError")
      Prop("uri") { view: CortexAiAgentHubPdfView, uri: String -> view.load(uri) }
      OnViewDestroys { view: CortexAiAgentHubPdfView -> view.release() }
    }
  }
}
