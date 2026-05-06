from __future__ import annotations

import json
from pathlib import Path

import ctk
import qt
import slicer
import vtk
from slicer.ScriptedLoadableModule import ScriptedLoadableModule, ScriptedLoadableModuleWidget


class BronchoscopicBranchTracer(ScriptedLoadableModule):
    def __init__(self, parent):
        super().__init__(parent)
        parent.title = "Bronchoscopic Branch Tracer"
        parent.categories = ["BronchoEdu"]
        parent.dependencies = []
        parent.contributors = ["BronchoEdu prototype"]
        parent.helpText = "Educational route tracing module for synthetic bronchoscopy cases."
        parent.acknowledgementText = "For education and simulation only. Not for clinical use."


class BronchoscopicBranchTracerWidget(ScriptedLoadableModuleWidget):
    def setup(self):
        super().setup()
        self.controller = BranchTracerController()
        self.playTimer = qt.QTimer()
        self.playTimer.setInterval(250)
        self.playTimer.timeout.connect(self.onPlayTick)

        parametersCollapsibleButton = ctk.ctkCollapsibleButton()
        parametersCollapsibleButton.text = "Inputs"
        self.layout.addWidget(parametersCollapsibleButton)
        formLayout = qt.QFormLayout(parametersCollapsibleButton)

        self.ctSelector = slicer.qMRMLNodeComboBox()
        self.ctSelector.nodeTypes = ["vtkMRMLScalarVolumeNode"]
        self.ctSelector.selectNodeUponCreation = False
        self.ctSelector.addEnabled = False
        self.ctSelector.removeEnabled = False
        self.ctSelector.noneEnabled = True
        self.ctSelector.setMRMLScene(slicer.mrmlScene)
        formLayout.addRow("CT volume", self.ctSelector)

        self.routePath = ctk.ctkPathLineEdit()
        self.routePath.filters = ctk.ctkPathLineEdit.Files
        self.routePath.nameFilters = ["JSON (*.json)"]
        formLayout.addRow("Route JSON", self.routePath)

        self.curvesPath = ctk.ctkPathLineEdit()
        self.curvesPath.filters = ctk.ctkPathLineEdit.Dirs
        default_curves = Path("/Users/russellmiller/Projects/navigation_module/data/airway/curves")
        if default_curves.exists():
            self.curvesPath.currentPath = str(default_curves)
        formLayout.addRow("Network curves", self.curvesPath)

        self.airwaySelector = slicer.qMRMLNodeComboBox()
        self.airwaySelector.nodeTypes = ["vtkMRMLModelNode"]
        self.airwaySelector.selectNodeUponCreation = False
        self.airwaySelector.addEnabled = False
        self.airwaySelector.removeEnabled = False
        self.airwaySelector.noneEnabled = True
        self.airwaySelector.setMRMLScene(slicer.mrmlScene)
        formLayout.addRow("Airway model", self.airwaySelector)

        self.airwaySurfaceSelector = slicer.qMRMLNodeComboBox()
        self.airwaySurfaceSelector.nodeTypes = ["vtkMRMLSegmentationNode", "vtkMRMLLabelMapVolumeNode"]
        self.airwaySurfaceSelector.selectNodeUponCreation = False
        self.airwaySurfaceSelector.addEnabled = False
        self.airwaySurfaceSelector.removeEnabled = False
        self.airwaySurfaceSelector.noneEnabled = True
        self.airwaySurfaceSelector.setMRMLScene(slicer.mrmlScene)
        formLayout.addRow("Airway surface", self.airwaySurfaceSelector)

        self.maskSelector = slicer.qMRMLNodeComboBox()
        self.maskSelector.nodeTypes = ["vtkMRMLLabelMapVolumeNode", "vtkMRMLScalarVolumeNode"]
        self.maskSelector.selectNodeUponCreation = False
        self.maskSelector.addEnabled = False
        self.maskSelector.removeEnabled = False
        self.maskSelector.noneEnabled = True
        self.maskSelector.setMRMLScene(slicer.mrmlScene)
        formLayout.addRow("Nodule mask", self.maskSelector)

        controlsCollapsibleButton = ctk.ctkCollapsibleButton()
        controlsCollapsibleButton.text = "Route"
        self.layout.addWidget(controlsCollapsibleButton)
        controlsLayout = qt.QVBoxLayout(controlsCollapsibleButton)

        self.loadButton = qt.QPushButton("Load Route")
        self.loadButton.clicked.connect(self.onLoadRoute)
        controlsLayout.addWidget(self.loadButton)

        self.routeSlider = qt.QSlider(qt.Qt.Horizontal)
        self.routeSlider.minimum = 0
        self.routeSlider.maximum = 0
        self.routeSlider.valueChanged.connect(self.onSliderChanged)
        controlsLayout.addWidget(self.routeSlider)

        buttonRow = qt.QHBoxLayout()
        self.previousBifurcationButton = qt.QPushButton("Previous Bifurcation")
        self.previousBifurcationButton.clicked.connect(self.onPreviousBifurcation)
        buttonRow.addWidget(self.previousBifurcationButton)
        self.nextBifurcationButton = qt.QPushButton("Next Bifurcation")
        self.nextBifurcationButton.clicked.connect(self.onNextBifurcation)
        buttonRow.addWidget(self.nextBifurcationButton)
        self.playButton = qt.QPushButton("Play/Pause")
        self.playButton.clicked.connect(self.onPlayPause)
        buttonRow.addWidget(self.playButton)
        self.showCorrectButton = qt.QPushButton("Show/Hide Correct Route")
        self.showCorrectButton.clicked.connect(self.onToggleCorrectRoute)
        buttonRow.addWidget(self.showCorrectButton)
        controlsLayout.addLayout(buttonRow)

        cameraRow = qt.QHBoxLayout()
        self.endoscopicCameraCheck = qt.QCheckBox("Bronchoscopy render")
        self.endoscopicCameraCheck.checked = True
        self.endoscopicCameraCheck.toggled.connect(self.onEndoscopicCameraToggled)
        cameraRow.addWidget(self.endoscopicCameraCheck)
        self.patientSupineViewCheck = qt.QCheckBox("Head-end supine orientation")
        self.patientSupineViewCheck.checked = True
        self.patientSupineViewCheck.toggled.connect(self.onPatientSupineViewToggled)
        cameraRow.addWidget(self.patientSupineViewCheck)
        self.airwayPlanesCheck = qt.QCheckBox("Airway-aligned CT planes")
        self.airwayPlanesCheck.checked = False
        self.airwayPlanesCheck.toggled.connect(self.onAirwayPlanesToggled)
        cameraRow.addWidget(self.airwayPlanesCheck)
        self.endoscopicViewButton = qt.QPushButton("Jump to Scope View")
        self.endoscopicViewButton.clicked.connect(self.onEndoscopicView)
        cameraRow.addWidget(self.endoscopicViewButton)
        self.overviewButton = qt.QPushButton("Overview")
        self.overviewButton.clicked.connect(self.onOverview)
        cameraRow.addWidget(self.overviewButton)
        controlsLayout.addLayout(cameraRow)

        self.promptText = qt.QTextEdit()
        self.promptText.readOnly = True
        self.promptText.minimumHeight = 150
        controlsLayout.addWidget(self.promptText)

        self.decisionTable = qt.QTableWidget()
        self.decisionTable.setColumnCount(5)
        self.decisionTable.setHorizontalHeaderLabels(["Branch", "Length mm", "Mean radius", "Angle", "Endpoint dist"])
        self.decisionTable.cellClicked.connect(self.onDecisionCellClicked)
        controlsLayout.addWidget(self.decisionTable)

        self.layout.addStretch(1)

    def onLoadRoute(self):
        self.controller.load_route(self.routePath.currentPath)
        self.controller.ctNode = self.ctSelector.currentNode()
        self.controller.maskNode = self.maskSelector.currentNode()
        self.controller.airwayModelNode = self.airwaySelector.currentNode()
        self.controller.airwaySurfaceNode = self.airwaySurfaceSelector.currentNode()
        self.controller.curvesDirPath = self.curvesPath.currentPath
        self.controller.endoscopicCameraEnabled = self.endoscopicCameraCheck.checked
        self.controller.patientSupineBronchView = self.patientSupineViewCheck.checked
        self.controller.useAirwayAlignedPlanes = self.airwayPlanesCheck.checked
        self.controller.setup_scene()
        max_index = max(0, len(self.controller.points) - 1)
        self.routeSlider.blockSignals(True)
        self.routeSlider.maximum = max_index
        self.routeSlider.value = 0
        self.routeSlider.blockSignals(False)
        self.controller.set_route_index(0)
        self.updatePrompt()

    def onSliderChanged(self, value):
        self.controller.set_route_index(value)
        self.updatePrompt()

    def onPlayTick(self):
        if self.routeSlider.value >= self.routeSlider.maximum:
            self.playTimer.stop()
            return
        next_decision = self.controller.next_bifurcation_decision(after_index=self.controller.currentIndex)
        if next_decision:
            stop_index = self.controller.view_index_for_decision(next_decision)
            if self.controller.currentIndex < stop_index <= self.controller.currentIndex + 1:
                self.playTimer.stop()
                self.jumpToDecision(next_decision)
                return
        self.routeSlider.value += 1

    def onPlayPause(self):
        if self.playTimer.isActive():
            self.playTimer.stop()
        else:
            self.playTimer.start()

    def onToggleCorrectRoute(self):
        node = self.controller.routeCurveNode
        if node and node.GetDisplayNode():
            display = node.GetDisplayNode()
            display.SetVisibility(not display.GetVisibility())

    def onPreviousBifurcation(self):
        decision = self.controller.previous_bifurcation_decision(before_index=self.controller.currentIndex)
        if decision is not None:
            self.jumpToDecision(decision)

    def onNextBifurcation(self):
        decision = self.controller.next_bifurcation_decision(after_index=self.controller.currentIndex)
        if decision is not None:
            self.jumpToDecision(decision)

    def jumpToDecision(self, decision):
        self.controller.lock_decision(decision)
        index = self.controller.view_index_for_decision(decision)
        self.routeSlider.blockSignals(True)
        self.routeSlider.value = index
        self.routeSlider.blockSignals(False)
        self.controller.set_route_index(index, preserve_decision=True)
        self.controller.lock_decision(decision)
        self.controller.update_current_branch_guides()
        self.controller.apply_render_mode()
        self.updatePrompt()

    def onDecisionCellClicked(self, row, _column):
        decision = self.controller.current_bifurcation_prompt()
        if not decision:
            return
        options = decision.get("options", [])
        if row < 0 or row >= len(options):
            return
        option = options[row]
        self.controller.revealedDecision = decision.get("node_id")
        self.controller.selectedOptionIndex = row
        self.controller.update_current_branch_guides()
        verdict = "Correct" if option.get("is_correct_next_branch") else "Incorrect"
        self.updatePrompt(extra=f"{verdict}: compare endpoint-to-target distance and the CT plane correlate.")

    def onEndoscopicCameraToggled(self, checked):
        self.controller.endoscopicCameraEnabled = bool(checked)
        if checked:
            self.controller.update_camera(self.controller.currentIndex)
        else:
            self.controller.apply_overview_view_node_style()
            self.controller.apply_render_mode()

    def onAirwayPlanesToggled(self, checked):
        self.controller.useAirwayAlignedPlanes = bool(checked)
        self.controller.update_slice_planes(self.controller.currentIndex)

    def onPatientSupineViewToggled(self, checked):
        self.controller.patientSupineBronchView = bool(checked)
        if self.controller.endoscopicCameraEnabled:
            self.controller.update_camera(self.controller.currentIndex)

    def onEndoscopicView(self):
        self.endoscopicCameraCheck.checked = True
        self.controller.endoscopicCameraEnabled = True
        self.controller.update_camera(self.controller.currentIndex)

    def onOverview(self):
        self.endoscopicCameraCheck.checked = False
        self.controller.endoscopicCameraEnabled = False
        self.controller.set_overview_camera()

    def updatePrompt(self, extra=None):
        frame = self.controller.current_frame()
        decision = self.controller.current_bifurcation_prompt()
        lines = []
        lines.append(f"Route index: {self.controller.currentIndex}")
        if frame and "distance_to_target_mm" in frame:
            lines.append(f"Distance to target: {frame['distance_to_target_mm']} mm")
        if decision:
            lines.append("At this bifurcation, which branch leads toward the lesion?")
            lines.append(f"Decision {self.controller.decision_number(decision)} of {len(self.controller.decisions)}")
            lines.append("Numbered cyan guide-lines show the available branch choices.")
        else:
            lines.append("Advance along the route toward the next bifurcation.")
        if extra:
            lines.append(extra)
        self.promptText.setPlainText("\n".join(lines))
        self.populateDecisionTable(decision)

    def populateDecisionTable(self, decision):
        self.decisionTable.setRowCount(0)
        if not decision:
            return
        options = decision.get("options", [])
        self.decisionTable.setRowCount(len(options))
        for row, option in enumerate(options):
            is_revealed = self.controller.revealedDecision == decision.get("node_id")
            branch_label = f"Cell {option.get('cell_id')}"
            if is_revealed and option.get("is_correct_next_branch"):
                branch_label += " (correct)"
            values = [
                f"{self.controller.choice_label(row)}: {branch_label}",
                option.get("length_mm", ""),
                option.get("mean_radius_mm", ""),
                option.get("angle_to_target_degrees", ""),
                option.get("endpoint_to_target_distance_mm", ""),
            ]
            for col, value in enumerate(values):
                self.decisionTable.setItem(row, col, qt.QTableWidgetItem(str(value)))


class BranchTracerController:
    def __init__(self):
        self.route = None
        self.points = []
        self.frames = []
        self.decisions = []
        self.currentIndex = 0
        self.revealedDecision = None
        self.ctNode = None
        self.maskNode = None
        self.airwayModelNode = None
        self.airwaySurfaceNode = None
        self.curvesDirPath = None
        self.routeCurveNode = None
        self.currentFiducialNode = None
        self.lesionFiducialNode = None
        self.branchPointNode = None
        self.optionCurveNodes = []
        self.optionLabelNode = None
        self.selectedOptionIndex = None
        self.endoscopicCameraEnabled = True
        self.patientSupineBronchView = True
        self.useAirwayAlignedPlanes = False
        self.routeFilePath = None
        self.activeDecision = None
        self.decisionHoldRadius = 8

    def load_route(self, path):
        if not path:
            raise ValueError("Choose a route JSON file.")
        self.routeFilePath = path
        with open(path, "r", encoding="utf-8") as f:
            self.route = json.load(f)
        route_payload = self.route.get("route", {})
        self.points = route_payload.get("points_ras") or self.route.get("route_points_ras") or []
        self.frames = route_payload.get("frames") or self.route.get("frames") or []
        self.decisions = self.route.get("bifurcation_decisions", [])
        if not self.points:
            raise ValueError("Route JSON does not contain route.points_ras.")

    def setup_scene(self):
        self.clear_scene_nodes()
        self.configure_slice_layers()
        self.create_route_curve()
        self.create_current_marker()
        self.create_lesion_marker()
        self.create_branch_point_markers()
        self.configure_airway_surface()
        self.configure_airway_display()
        self.update_current_branch_guides()
        self.apply_render_mode()

    def clear_scene_nodes(self):
        for node in [
            self.routeCurveNode,
            self.currentFiducialNode,
            self.lesionFiducialNode,
            self.branchPointNode,
            self.optionLabelNode,
        ]:
            if node:
                slicer.mrmlScene.RemoveNode(node)
        for node in self.optionCurveNodes:
            if node:
                slicer.mrmlScene.RemoveNode(node)
        self.routeCurveNode = None
        self.currentFiducialNode = None
        self.lesionFiducialNode = None
        self.branchPointNode = None
        self.optionLabelNode = None
        self.optionCurveNodes = []

    def configure_slice_layers(self):
        if not self.ctNode:
            return
        layout_manager = slicer.app.layoutManager()
        for slice_name in ["Red", "Yellow", "Green"]:
            widget = layout_manager.sliceWidget(slice_name)
            if widget is None:
                continue
            composite_node = widget.mrmlSliceCompositeNode()
            composite_node.SetBackgroundVolumeID(self.ctNode.GetID())
            if self.maskNode:
                composite_node.SetLabelVolumeID(self.maskNode.GetID())
                composite_node.SetLabelOpacity(0.35)

    def create_route_curve(self):
        curve = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsCurveNode", "Planned airway route")
        curve.SetCurveTypeToLinear()
        for point in self.points:
            curve.AddControlPointWorld(vtk.vtkVector3d(float(point[0]), float(point[1]), float(point[2])))
        display = curve.GetDisplayNode()
        if display:
            display.SetVisibility(True)
            self._set_display_color(display, (0.45, 0.25, 1.0))
            self._set_selected_color(display, (0.45, 0.25, 1.0))
            self._set_line_thickness(display, 0.25)
            self._set_markups_labels(display, False)
            self._set_glyph_scale(display, 0.0)
            self._set_glyph_hidden(display, True)
            self._set_visibility_2d_3d(display, True, True)
        self.routeCurveNode = curve

    def create_current_marker(self):
        fid = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsFiducialNode", "Current bronchoscope position")
        p = self.points[0]
        fid.AddControlPointWorld(vtk.vtkVector3d(float(p[0]), float(p[1]), float(p[2])))
        display = fid.GetDisplayNode()
        if display:
            self._set_display_color(display, (1.0, 0.25, 0.2))
            self._set_selected_color(display, (1.0, 0.25, 0.2))
            self._set_markups_labels(display, False)
            self._set_glyph_scale(display, 0.9)
        self.currentFiducialNode = fid

    def create_lesion_marker(self):
        target = self.route.get("target_ras") if self.route else None
        if not target:
            return
        fid = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsFiducialNode", "Synthetic lesion centroid")
        fid.AddControlPointWorld(vtk.vtkVector3d(float(target[0]), float(target[1]), float(target[2])))
        display = fid.GetDisplayNode()
        if display:
            self._set_display_color(display, (0.1, 1.0, 0.25))
            self._set_selected_color(display, (0.1, 1.0, 0.25))
            self._set_markups_labels(display, False)
            self._set_glyph_scale(display, 1.2)
        self.lesionFiducialNode = fid

    def create_branch_point_markers(self):
        if not self.decisions:
            return
        node = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsFiducialNode", "Route bifurcation points")
        for idx, decision in enumerate(self.decisions, start=1):
            point = decision.get("node_ras")
            if not point:
                continue
            node.AddControlPointWorld(vtk.vtkVector3d(float(point[0]), float(point[1]), float(point[2])))
            try:
                node.SetNthControlPointLabel(node.GetNumberOfControlPoints() - 1, f"B{idx}")
            except Exception:
                pass
        display = node.GetDisplayNode()
        if display:
            self._set_display_color(display, (1.0, 0.9, 0.1))
            self._set_selected_color(display, (1.0, 0.9, 0.1))
            self._set_markups_labels(display, True)
            self._set_glyph_scale(display, 1.1)
            self._set_text_scale(display, 2.0)
        self.branchPointNode = node

    def configure_airway_display(self):
        if self.airwayModelNode and self.airwayModelNode.GetDisplayNode():
            display = self.airwayModelNode.GetDisplayNode()
            display.SetOpacity(0.04 if self.airwaySurfaceNode else 0.12)
            display.SetVisibility(True)

    def configure_airway_surface(self):
        node = self.airwaySurfaceNode or self.auto_load_airway_surface()
        if node is None:
            return
        if node.IsA("vtkMRMLLabelMapVolumeNode"):
            node = self.segmentation_from_labelmap(node)
        if node is None or not node.IsA("vtkMRMLSegmentationNode"):
            return
        self.airwaySurfaceNode = node
        try:
            node.CreateClosedSurfaceRepresentation()
        except Exception as exc:
            print(f"BronchoscopicBranchTracer: airway surface conversion skipped: {exc}")
        try:
            if not node.GetDisplayNode():
                node.CreateDefaultDisplayNodes()
            display = node.GetDisplayNode()
            if display:
                display.SetVisibility(True)
                if hasattr(display, "SetVisibility3D"):
                    display.SetVisibility3D(True)
                if hasattr(display, "SetOpacity3D"):
                    display.SetOpacity3D(0.48)
                if hasattr(display, "SetVisibility2DFill"):
                    display.SetVisibility2DFill(False)
                if hasattr(display, "SetVisibility2DOutline"):
                    display.SetVisibility2DOutline(True)
                if hasattr(display, "SetOpacity2DFill"):
                    display.SetOpacity2DFill(0.08)
                if hasattr(display, "SetBackfaceCulling"):
                    display.SetBackfaceCulling(False)
                segmentation = node.GetSegmentation()
                for i in range(segmentation.GetNumberOfSegments()):
                    segment_id = segmentation.GetNthSegmentID(i)
                    segment = segmentation.GetSegment(segment_id)
                    segment.SetColor(0.95, 0.55, 0.42)
                    if hasattr(display, "SetSegmentOpacity3D"):
                        display.SetSegmentOpacity3D(segment_id, 1.0 if self.endoscopicCameraEnabled else 0.42)
                    if hasattr(display, "SetSegmentVisibility"):
                        display.SetSegmentVisibility(segment_id, True)
        except Exception as exc:
            print(f"BronchoscopicBranchTracer: airway surface display skipped: {exc}")

    def auto_load_airway_surface(self):
        if not self.routeFilePath:
            return None
        try:
            route_path = Path(self.routeFilePath)
            candidates = [
                route_path.parents[2] / "Airway.seg.nrrd",
                route_path.parents[1] / "Airway.seg.nrrd",
                Path("/Users/russellmiller/Projects/navigation_module/Airway.seg.nrrd"),
            ]
            for candidate in candidates:
                if not candidate.exists():
                    continue
                success, node = slicer.util.loadSegmentation(str(candidate), returnNode=True)
                if success:
                    node.SetName("Airway surface")
                    return node
        except Exception as exc:
            print(f"BronchoscopicBranchTracer: auto-load airway surface skipped: {exc}")
        return None

    @staticmethod
    def segmentation_from_labelmap(labelmap_node):
        try:
            segmentation_node = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode", "Airway surface")
            slicer.modules.segmentations.logic().ImportLabelmapToSegmentationNode(labelmap_node, segmentation_node)
            return segmentation_node
        except Exception as exc:
            print(f"BronchoscopicBranchTracer: labelmap to segmentation skipped: {exc}")
            return None

    def set_route_index(self, index, preserve_decision=False):
        if not self.points:
            return
        index = max(0, min(int(index), len(self.points) - 1))
        self.currentIndex = index
        if not preserve_decision:
            self.update_active_decision_for_index(index)
        point = self.frame_origin(index)
        if self.currentFiducialNode:
            self.currentFiducialNode.SetNthControlPointPositionWorld(0, vtk.vtkVector3d(float(point[0]), float(point[1]), float(point[2])))
        focus = self.slice_focus_point(index)
        slicer.modules.markups.logic().JumpSlicesToLocation(float(focus[0]), float(focus[1]), float(focus[2]), True)
        self.update_slice_planes(index)
        self.update_current_branch_guides()
        if self.endoscopicCameraEnabled:
            self.update_camera(index)
        self.apply_render_mode()

    def frame_origin(self, index):
        frame = self.frame_at(index)
        if frame and frame.get("origin_ras"):
            return frame["origin_ras"]
        return self.points[index]

    def frame_at(self, index):
        if 0 <= index < len(self.frames):
            return self.frames[index]
        return None

    def current_frame(self):
        return self.frame_at(self.currentIndex)

    def update_slice_planes(self, index):
        focus = self.slice_focus_point(index)
        if not self.useAirwayAlignedPlanes:
            self.set_standard_slice_planes()
            slicer.modules.markups.logic().JumpSlicesToLocation(float(focus[0]), float(focus[1]), float(focus[2]), True)
            return
        frame = self.frame_at(index)
        if not frame:
            return
        planes = frame.get("ct_planes", {})
        self._set_slice_to_plane("Red", self.plane_with_focus(planes.get("airway_cross_section"), focus))
        self._set_slice_to_plane("Yellow", self.plane_with_focus(planes.get("airway_long_axis_normal"), focus))
        self._set_slice_to_plane("Green", self.plane_with_focus(planes.get("lesion_directed_long_axis") or planes.get("airway_long_axis_binormal"), focus))

    def slice_focus_point(self, index):
        decision = self.current_bifurcation_prompt()
        if decision and decision.get("node_ras"):
            return decision["node_ras"]
        return self.frame_origin(index)

    @staticmethod
    def plane_with_focus(plane, focus):
        if not plane:
            return None
        out = dict(plane)
        out["origin_ras"] = [float(v) for v in focus]
        return out

    @staticmethod
    def set_standard_slice_planes():
        orientations = {
            "Red": "Axial",
            "Yellow": "Sagittal",
            "Green": "Coronal",
        }
        for slice_name, orientation in orientations.items():
            try:
                widget = slicer.app.layoutManager().sliceWidget(slice_name)
                if widget is None:
                    continue
                slice_node = widget.mrmlSliceNode()
                method = getattr(slice_node, f"SetOrientationTo{orientation}", None)
                if method:
                    method()
                elif hasattr(slice_node, "SetOrientation"):
                    slice_node.SetOrientation(orientation)
                slice_node.UpdateMatrices()
            except Exception as exc:
                print(f"BronchoscopicBranchTracer: standard {slice_name} plane skipped: {exc}")

    @staticmethod
    def _set_slice_to_plane(slice_name, plane):
        if not plane:
            return
        try:
            widget = slicer.app.layoutManager().sliceWidget(slice_name)
            if widget is None:
                return
            slice_node = widget.mrmlSliceNode()
            origin = plane["origin_ras"]
            x_axis = plane["x_axis_ras"]
            normal = plane["normal_ras"]
            if hasattr(slice_node, "SetSliceToRASByNTP"):
                slice_node.SetSliceToRASByNTP(
                    float(normal[0]), float(normal[1]), float(normal[2]),
                    float(x_axis[0]), float(x_axis[1]), float(x_axis[2]),
                    float(origin[0]), float(origin[1]), float(origin[2]),
                    0,
                )
            else:
                y_axis = plane["y_axis_ras"]
                matrix = vtk.vtkMatrix4x4()
                for col, vec in enumerate([x_axis, y_axis, normal, origin]):
                    for row in range(3):
                        matrix.SetElement(row, col, float(vec[row]))
                matrix.SetElement(3, 0, 0.0)
                matrix.SetElement(3, 1, 0.0)
                matrix.SetElement(3, 2, 0.0)
                matrix.SetElement(3, 3, 1.0)
                slice_node.GetSliceToRAS().DeepCopy(matrix)
            slice_node.UpdateMatrices()
        except Exception as exc:
            print(f"BronchoscopicBranchTracer: slice plane update skipped for {slice_name}: {exc}")

    def update_camera(self, index):
        if not self.endoscopicCameraEnabled:
            return
        frame = self.frame_at(index)
        if not frame:
            return
        camera_payload = frame.get("bronchoscope_camera")
        if not camera_payload:
            return
        try:
            view_node = slicer.app.layoutManager().threeDWidget(0).mrmlViewNode()
            camera_node = slicer.modules.cameras.logic().GetViewActiveCameraNode(view_node)
            camera = camera_node.GetCamera()
            position = camera_payload["position_ras"]
            direction = camera_payload["view_direction_ras"]
            if self.patientSupineBronchView:
                direction = self.head_to_foot_direction(direction)
                up = self.supine_screen_up(direction)
            else:
                up = camera_payload.get("up_ras", [0, 0, 1])
            focal = [position[i] + 35.0 * direction[i] for i in range(3)]
            camera_position = [position[i] - 1.5 * direction[i] for i in range(3)]
            camera.SetPosition(*[float(v) for v in camera_position])
            camera.SetFocalPoint(*[float(v) for v in focal])
            camera.SetViewUp(*[float(v) for v in up])
            camera.SetViewAngle(82.0)
            camera.SetClippingRange(0.05, 90.0)
            camera_node.Modified()
            self.apply_endoscopic_view_node_style()
        except Exception as exc:
            print(f"BronchoscopicBranchTracer: camera update skipped: {exc}")

    def head_to_foot_direction(self, direction):
        direction = self._unit(direction, [0.0, 0.0, -1.0])
        # Bronchoscopy is advanced from the head/proximal trachea toward the feet.
        # If a tangent points superiorly, flip it so the virtual scope looks distally.
        if direction[2] > 0:
            direction = [-direction[0], -direction[1], -direction[2]]
        return direction

    def supine_screen_up(self, direction):
        # Patient supine convention: anterior/chest is kept near the top of the
        # endoscopic image. In RAS, anterior is +A.
        anterior = [0.0, 1.0, 0.0]
        up = self._project_to_plane(anterior, direction)
        if self._norm(up) < 1e-6:
            up = self._project_to_plane([0.0, 0.0, 1.0], direction)
        return self._unit(up, [0.0, 1.0, 0.0])

    def set_overview_camera(self):
        try:
            three_d_widget = slicer.app.layoutManager().threeDWidget(0)
            three_d_widget.threeDView().resetFocalPoint()
            view_node = three_d_widget.mrmlViewNode()
            camera_node = slicer.modules.cameras.logic().GetViewActiveCameraNode(view_node)
            camera = camera_node.GetCamera()
            camera.SetViewAngle(30.0)
            camera.SetClippingRange(1.0, 2000.0)
            camera_node.Modified()
            self.apply_overview_view_node_style()
            self.apply_render_mode()
        except Exception as exc:
            print(f"BronchoscopicBranchTracer: overview camera skipped: {exc}")

    def apply_endoscopic_view_node_style(self):
        try:
            view_node = slicer.app.layoutManager().threeDWidget(0).mrmlViewNode()
            if hasattr(view_node, "SetBoxVisible"):
                view_node.SetBoxVisible(False)
            if hasattr(view_node, "SetAxisLabelsVisible"):
                view_node.SetAxisLabelsVisible(False)
            if hasattr(view_node, "SetBackgroundColor"):
                view_node.SetBackgroundColor(0.0, 0.0, 0.0)
            if hasattr(view_node, "SetBackgroundColor2"):
                view_node.SetBackgroundColor2(0.0, 0.0, 0.0)
        except Exception:
            pass

    def apply_overview_view_node_style(self):
        try:
            view_node = slicer.app.layoutManager().threeDWidget(0).mrmlViewNode()
            if hasattr(view_node, "SetBoxVisible"):
                view_node.SetBoxVisible(True)
            if hasattr(view_node, "SetAxisLabelsVisible"):
                view_node.SetAxisLabelsVisible(True)
            if hasattr(view_node, "SetBackgroundColor"):
                view_node.SetBackgroundColor(0.45, 0.48, 0.68)
            if hasattr(view_node, "SetBackgroundColor2"):
                view_node.SetBackgroundColor2(0.75, 0.78, 0.95)
        except Exception:
            pass

    def apply_render_mode(self):
        if self.endoscopicCameraEnabled:
            self.apply_endoscopic_render_mode()
        else:
            self.apply_teaching_render_mode()

    def apply_endoscopic_render_mode(self):
        for node in [self.routeCurveNode, self.currentFiducialNode, self.lesionFiducialNode, self.branchPointNode]:
            self._set_node_visibility_3d(node, False)
        self._set_node_visibility_3d(self.optionLabelNode, True)
        for node in self.optionCurveNodes:
            self._set_node_visibility_3d(node, True)
        if self.airwayModelNode and self.airwayModelNode.GetDisplayNode():
            self.airwayModelNode.GetDisplayNode().SetVisibility(False)
        self._set_airway_surface_endoscopic(True)

    def apply_teaching_render_mode(self):
        for node in [self.routeCurveNode, self.currentFiducialNode, self.lesionFiducialNode, self.branchPointNode, self.optionLabelNode]:
            self._set_node_visibility_3d(node, True)
        for node in self.optionCurveNodes:
            self._set_node_visibility_3d(node, True)
        if self.airwayModelNode and self.airwayModelNode.GetDisplayNode():
            self.airwayModelNode.GetDisplayNode().SetVisibility(True)
        self._set_airway_surface_endoscopic(False)

    def _set_airway_surface_endoscopic(self, enabled):
        node = self.airwaySurfaceNode
        if node is None or not node.IsA("vtkMRMLSegmentationNode") or not node.GetDisplayNode():
            return
        display = node.GetDisplayNode()
        if hasattr(display, "SetOpacity3D"):
            display.SetOpacity3D(1.0 if enabled else 0.42)
        if hasattr(display, "SetVisibility3D"):
            display.SetVisibility3D(True)
        if hasattr(display, "SetBackfaceCulling"):
            display.SetBackfaceCulling(False)
        try:
            segmentation = node.GetSegmentation()
            for i in range(segmentation.GetNumberOfSegments()):
                segment_id = segmentation.GetNthSegmentID(i)
                segment = segmentation.GetSegment(segment_id)
                if enabled:
                    segment.SetColor(0.95, 0.55, 0.42)
                else:
                    segment.SetColor(0.65, 0.85, 0.9)
                if hasattr(display, "SetSegmentOpacity3D"):
                    display.SetSegmentOpacity3D(segment_id, 1.0 if enabled else 0.42)
        except Exception:
            pass

    def current_bifurcation_prompt(self):
        if self.activeDecision is not None:
            return self.activeDecision
        for decision in self.decisions:
            route_index = decision.get("route_point_index")
            view_index = self.view_index_for_decision(decision)
            if route_index is not None and abs(int(view_index) - self.currentIndex) <= 2:
                return decision
        return None

    def update_active_decision_for_index(self, index):
        matched = self.decision_at_or_near_index(index)
        if matched is not None:
            if matched is not self.activeDecision:
                self.selectedOptionIndex = None
                self.revealedDecision = None
            self.activeDecision = matched
            return
        if self.activeDecision is not None:
            active_index = self.view_index_for_decision(self.activeDecision)
            if abs(int(index) - int(active_index)) > self.decisionHoldRadius:
                self.activeDecision = None
                self.selectedOptionIndex = None
                self.revealedDecision = None

    def decision_at_or_near_index(self, index):
        for decision in self.decisions:
            view_index = self.view_index_for_decision(decision)
            route_index = decision.get("route_point_index")
            if abs(int(view_index) - int(index)) <= 1:
                return decision
            if route_index is not None and abs(int(route_index) - int(index)) <= 1:
                return decision
        return None

    def lock_decision(self, decision):
        if decision is not self.activeDecision:
            self.selectedOptionIndex = None
            self.revealedDecision = None
        self.activeDecision = decision

    def view_index_for_decision(self, decision):
        route_index = int(decision.get("route_point_index") or 0)
        return max(0, route_index - 4)

    def decision_number(self, decision):
        try:
            return self.decisions.index(decision) + 1
        except ValueError:
            return "?"

    def update_current_branch_guides(self):
        self.clear_option_guides()
        decision = self.current_bifurcation_prompt()
        if not decision:
            return
        origin = decision.get("node_ras")
        if not origin:
            return
        options = decision.get("options", [])
        label_node = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsFiducialNode", "Current branch option labels")
        for idx, option in enumerate(options):
            points = self.points_for_branch_option(option, origin)
            end = points[-1]
            line = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsCurveNode", f"Option {idx + 1}")
            line.SetCurveTypeToLinear()
            for point in points:
                line.AddControlPointWorld(vtk.vtkVector3d(float(point[0]), float(point[1]), float(point[2])))
            self.hide_control_points(line)
            color = self.branch_option_color(decision, option, idx)
            display = line.GetDisplayNode()
            if display:
                self._set_display_color(display, color)
                self._set_selected_color(display, color)
                self._set_line_thickness(display, 0.8)
                self._set_markups_labels(display, False)
                self._set_glyph_scale(display, 0.0)
                self._set_glyph_hidden(display, True)
                self._set_visibility_2d_3d(display, True, True)
            self.optionCurveNodes.append(line)

            label_point = self.branch_label_point(points, origin, distance_mm=8.0)
            label_node.AddControlPointWorld(vtk.vtkVector3d(label_point[0], label_point[1], label_point[2]))
            try:
                label_node.SetNthControlPointLabel(label_node.GetNumberOfControlPoints() - 1, self.choice_label(idx))
            except Exception:
                pass
        display = label_node.GetDisplayNode()
        if display:
            self._set_display_color(display, (1.0, 0.0, 0.0))
            self._set_selected_color(display, (1.0, 0.0, 0.0))
            self._set_markups_labels(display, True)
            self._set_glyph_scale(display, 0.0)
            self._set_glyph_hidden(display, True)
            self._set_text_scale(display, 4.0)
            self._set_visibility_2d_3d(display, True, True)
        self.optionLabelNode = label_node
        self.apply_render_mode()

    @staticmethod
    def choice_label(index):
        labels = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        if 0 <= int(index) < len(labels):
            return labels[int(index)]
        return str(int(index) + 1)

    def points_for_branch_option(self, option, origin):
        curve_points = self.network_curve_points(option.get("cell_id", option.get("edge_id")))
        if curve_points:
            if self._distance(curve_points[-1], origin) < self._distance(curve_points[0], origin):
                curve_points = list(reversed(curve_points))
            return curve_points
        end = option.get("to_node_ras")
        if not end:
            direction = option.get("first_direction_ras", [1.0, 0.0, 0.0])
            end = [float(origin[i]) + 20.0 * float(direction[i]) for i in range(3)]
        return [origin, end]

    def branch_label_point(self, points, origin, distance_mm=8.0):
        if not points:
            return [float(v) for v in origin]
        if len(points) == 1:
            return [float(v) for v in points[0]]
        cumulative = 0.0
        previous = [float(v) for v in points[0]]
        # Make sure the label starts from the bifurcation coordinate, even if
        # the exported curve's first sampled point is a hair off.
        if self._distance(previous, origin) > 2.0:
            previous = [float(v) for v in origin]
        for current_raw in points[1:]:
            current = [float(v) for v in current_raw]
            segment_length = self._distance(previous, current)
            if segment_length < 1e-6:
                previous = current
                continue
            if cumulative + segment_length >= distance_mm:
                fraction = (distance_mm - cumulative) / segment_length
                return [
                    previous[i] + fraction * (current[i] - previous[i])
                    for i in range(3)
                ]
            cumulative += segment_length
            previous = current
        return previous

    def network_curve_points(self, cell_id):
        if cell_id is None:
            return None
        curves_dir = Path(self.curvesDirPath) if self.curvesDirPath else self.default_curves_dir()
        if curves_dir is None:
            return None
        path = curves_dir / f"Network curve ({int(cell_id)}).mrk.json"
        if not path.exists():
            return None
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            markup = payload["markups"][0]
            coordinate_system = markup.get("coordinateSystem", "LPS").upper()
            points = []
            for control_point in markup.get("controlPoints", []):
                point = [float(v) for v in control_point["position"]]
                if coordinate_system == "LPS":
                    point = [-point[0], -point[1], point[2]]
                points.append(point)
            return points or None
        except Exception as exc:
            print(f"BronchoscopicBranchTracer: could not load network curve {path}: {exc}")
            return None

    def default_curves_dir(self):
        candidates = []
        if self.routeFilePath:
            route_path = Path(self.routeFilePath)
            try:
                candidates.append(route_path.parents[2] / "data/airway/curves")
            except Exception:
                pass
        candidates.append(Path("/Users/russellmiller/Projects/navigation_module/data/airway/curves"))
        for candidate in candidates:
            if candidate.exists():
                return candidate
        return None

    @staticmethod
    def _distance(a, b):
        return sum((float(a[i]) - float(b[i])) ** 2 for i in range(3)) ** 0.5

    def branch_option_color(self, decision, option, index):
        is_revealed = self.revealedDecision == decision.get("node_id")
        if is_revealed:
            if option.get("is_correct_next_branch"):
                return (0.0, 0.95, 0.2)
            if self.selectedOptionIndex == index:
                return (1.0, 0.15, 0.1)
        palette = [
            (0.0, 0.85, 1.0),
            (1.0, 0.85, 0.0),
            (1.0, 0.25, 1.0),
            (1.0, 0.55, 0.0),
        ]
        return palette[index % len(palette)]

    def clear_option_guides(self):
        for node in self.optionCurveNodes:
            if node:
                slicer.mrmlScene.RemoveNode(node)
        self.optionCurveNodes = []
        if self.optionLabelNode:
            slicer.mrmlScene.RemoveNode(self.optionLabelNode)
            self.optionLabelNode = None

    def previous_bifurcation_decision(self, before_index):
        candidates = [
            decision
            for decision in self.decisions
            if self.view_index_for_decision(decision) < int(before_index)
        ]
        if candidates:
            return max(candidates, key=self.view_index_for_decision)
        return self.decisions[0] if self.decisions else None

    def next_bifurcation_decision(self, after_index):
        candidates = [
            decision
            for decision in self.decisions
            if self.view_index_for_decision(decision) > int(after_index)
        ]
        if candidates:
            return min(candidates, key=self.view_index_for_decision)
        return self.decisions[-1] if self.decisions else None

    @staticmethod
    def hide_control_points(node):
        try:
            for i in range(node.GetNumberOfControlPoints()):
                node.SetNthControlPointVisibility(i, False)
        except Exception:
            pass

    @staticmethod
    def _set_display_color(display, color):
        if hasattr(display, "SetColor"):
            display.SetColor(float(color[0]), float(color[1]), float(color[2]))

    @staticmethod
    def _set_selected_color(display, color):
        if hasattr(display, "SetSelectedColor"):
            display.SetSelectedColor(float(color[0]), float(color[1]), float(color[2]))

    @staticmethod
    def _set_line_thickness(display, thickness):
        if hasattr(display, "SetLineThickness"):
            display.SetLineThickness(float(thickness))

    @staticmethod
    def _set_glyph_scale(display, scale):
        if hasattr(display, "SetGlyphScale"):
            display.SetGlyphScale(float(scale))

    @staticmethod
    def _set_text_scale(display, scale):
        if hasattr(display, "SetTextScale"):
            display.SetTextScale(float(scale))

    @staticmethod
    def _set_markups_labels(display, visible):
        for method_name in ["SetPointLabelsVisibility", "SetPropertiesLabelVisibility"]:
            if hasattr(display, method_name):
                try:
                    getattr(display, method_name)(bool(visible))
                except Exception:
                    pass
        if not visible and hasattr(display, "SetTextScale"):
            display.SetTextScale(0.0)

    @staticmethod
    def _set_glyph_hidden(display, hidden):
        if not hidden:
            return
        if hasattr(display, "SetGlyphTypeFromString"):
            try:
                display.SetGlyphTypeFromString("None")
                return
            except Exception:
                pass
        if hasattr(display, "SetGlyphType"):
            try:
                display.SetGlyphType(0)
            except Exception:
                pass

    @staticmethod
    def _set_visibility_2d_3d(display, visible_2d, visible_3d):
        if hasattr(display, "SetVisibility2D"):
            display.SetVisibility2D(bool(visible_2d))
        if hasattr(display, "SetVisibility3D"):
            display.SetVisibility3D(bool(visible_3d))

    @staticmethod
    def _set_node_visibility_3d(node, visible):
        if node is None or not node.GetDisplayNode():
            return
        display = node.GetDisplayNode()
        if hasattr(display, "SetVisibility3D"):
            display.SetVisibility3D(bool(visible))
        else:
            display.SetVisibility(bool(visible))

    @staticmethod
    def _norm(vector):
        return sum(float(v) * float(v) for v in vector) ** 0.5

    @classmethod
    def _unit(cls, vector, fallback):
        norm = cls._norm(vector)
        if norm < 1e-9:
            return [float(v) for v in fallback]
        return [float(v) / norm for v in vector]

    @staticmethod
    def _dot(a, b):
        return sum(float(a[i]) * float(b[i]) for i in range(3))

    @classmethod
    def _project_to_plane(cls, vector, normal):
        normal = cls._unit(normal, [0.0, 0.0, -1.0])
        dot = cls._dot(vector, normal)
        return [float(vector[i]) - dot * normal[i] for i in range(3)]
